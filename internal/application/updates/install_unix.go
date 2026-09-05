//go:build !windows

package updates

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func init() {
	filePlatform = posixFilePlatform{}
}

// posixFilePlatform implements the single-file transaction for unix systems
// (linux and darwin): same-filesystem backup without moving the live path,
// atomic rename-in, and a detached helper handoff.
type posixFilePlatform struct{}

// activate preserves the previous installation as a same-filesystem backup,
// then atomically renames the staged executable over the live name — the
// live path is never renamed away first. File and directory metadata are
// flushed, and only then is the activated phase persisted.
func (posixFilePlatform) activate(i *Installer, op Operation, payload *Payload) (Operation, error) {
	if err := backupFile(i.Executable, op.Backup); err != nil {
		return Operation{}, fmt.Errorf("activate: preserve previous installation: %w", err)
	}
	if err := os.Chmod(payload.Executable, 0o755); err != nil {
		return Operation{}, fmt.Errorf("activate: stage executable mode: %w", err)
	}
	// The staged file lives on the destination filesystem, so this rename is
	// atomic: the live path flips from previous to new content in one step.
	if err := os.Rename(payload.Executable, i.Executable); err != nil {
		return Operation{}, fmt.Errorf("activate: install staged executable: %w", err)
	}
	if err := syncDir(i.journal.dir); err != nil {
		return Operation{}, fmt.Errorf("activate: flush install directory: %w", err)
	}
	op.Phase = PhaseActivated
	op.Deadline = i.now().Add(i.HealthTimeout)
	if err := i.journal.Save(op); err != nil {
		return Operation{}, fmt.Errorf("activate: persist activated phase: %w", err)
	}
	return op, nil
}

// handoff spawns the verified staged binary — now at the live path — in
// helper mode, detached. The caller must exit promptly so the helper can
// complete launch, health acknowledgement, and rollback.
func (posixFilePlatform) handoff(i *Installer, op Operation, payload *Payload) error {
	env := append(cleanEnvironment(), helperEnv(i)...)
	env = append(
		env,
		helperLiveEnv+"="+i.Executable,
		helperBundleEnv+"="+i.BundlePath,
	)
	if _, err := spawnDetached(i.Executable, env); err != nil {
		return fmt.Errorf("handoff: start update helper: %w", err)
	}
	return nil
}

// rollback atomically renames the backup over the live path and persists
// the rolled-back phase with next-startup suppression. A failed restore
// leaves the backup in place and records the failure.
func (posixFilePlatform) rollback(i *Installer, op Operation, reason string) error {
	restoreErr := restoreFile(op.Backup, i.livePath())
	op.Phase = PhaseRolledBack
	op.SuppressNext = true
	if restoreErr != nil {
		op.FailedError = fmt.Sprintf("%s: %v", reason, restoreErr)
	}
	if err := i.journal.Save(op); err != nil {
		return fmt.Errorf("rollback: persist rolled-back phase: %v (restore: %v)", err, restoreErr)
	}
	if restoreErr != nil {
		return fmt.Errorf("rollback: restore previous installation: %w", restoreErr)
	}
	return nil
}

// runHelper waits for the old process to exit, launches the new
// installation, waits a bounded time for its health acknowledgement, and on
// timeout or early death restores the backup and relaunches the previous
// installation with startup-update suppression for this recovery only.
func (posixFilePlatform) runHelper(ctx context.Context, installer *Installer, journal *Journal, op Operation, parentPID int) error {
	if err := waitProcessExit(ctx, parentPID, parentExitTimeout); err != nil {
		return fmt.Errorf("helper: %w", err)
	}
	child, err := spawnDetached(installer.Executable, cleanEnvironment())
	if err != nil {
		// The new installation never started: restore the previous one.
		rollbackErr := installer.Rollback(op, "helper launch failed")
		if rollbackErr == nil {
			rollbackErr = relaunchPrevious(installer.Executable)
		}
		return errors.Join(err, rollbackErr)
	}
	if err := awaitHealth(ctx, installer, journal, child); err != nil {
		// Timeout or early death: restore the backup and relaunch the
		// previous installation. Suppression rides in the rolled-back
		// journal so the recovery restart skips the updater once.
		rollbackErr := installer.Rollback(op, err.Error())
		if rollbackErr == nil {
			rollbackErr = relaunchPrevious(installer.Executable)
		}
		return errors.Join(err, rollbackErr)
	}
	return installer.Cleanup(op)
}

// backupFile preserves the previous file content at backupPath without
// moving the live path. A hard link keeps it instant and same-filesystem;
// filesystems without links fall back to a streamed copy.
func backupFile(livePath, backupPath string) error {
	err := os.Link(livePath, backupPath)
	if err == nil {
		return syncDir(filepath.Dir(livePath))
	}
	if !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.EOPNOTSUPP) && !errors.Is(err, syscall.EMLINK) {
		return fmt.Errorf("link backup: %w", err)
	}
	src, err := os.Open(livePath)
	if err != nil {
		return fmt.Errorf("copy backup: %w", err)
	}
	defer src.Close()
	dst, err := os.OpenFile(backupPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return fmt.Errorf("copy backup: %w", err)
	}
	_, copyErr := io.Copy(dst, src)
	if copyErr == nil {
		copyErr = dst.Sync()
	}
	if closeErr := dst.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		os.Remove(backupPath)
		return fmt.Errorf("copy backup: %w", copyErr)
	}
	return syncDir(filepath.Dir(livePath))
}

// restoreFile atomically renames the backup over the live path and flushes
// the directory metadata.
func restoreFile(backupPath, livePath string) error {
	if err := os.Rename(backupPath, livePath); err != nil {
		return fmt.Errorf("restore backup: %w", err)
	}
	return syncDir(filepath.Dir(livePath))
}

// lockExclusive takes exclusive, non-blocking ownership of the operation
// lock file.
func lockExclusive(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}

// unlockExclusive releases the operation lock.
func unlockExclusive(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}

// syncDir flushes a directory's metadata (renames, links, unlinks) to disk.
func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open directory: %w", err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return fmt.Errorf("flush directory: %w", err)
	}
	return nil
}

// spawnDetached starts path in its own session so the launched installation
// survives this process, with env replacing the environment entirely.
func spawnDetached(path string, env []string) (*detachedProcess, error) {
	cmd := exec.Command(path)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	detached := &detachedProcess{cmd: cmd, finished: make(chan struct{})}
	go func() {
		cmd.Wait()
		close(detached.finished)
	}()
	return detached, nil
}

// processAlive reports whether a non-child process still exists.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// waitProcessExit blocks until pid no longer exists or the timeout passes.
// A zero pid (unknown parent) returns immediately.
func waitProcessExit(ctx context.Context, pid int, timeout time.Duration) error {
	if pid <= 0 {
		return nil
	}
	deadline := time.Now().Add(timeout)
	for processAlive(pid) {
		if ctx.Err() != nil {
			return fmt.Errorf("wait for process %d: %w", pid, ctx.Err())
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("process %d did not exit within %s", pid, timeout)
		}
		sleep(ctx, ackPollInterval)
	}
	return nil
}
