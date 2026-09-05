//go:build windows

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

	"golang.org/x/sys/windows"
)

func init() {
	filePlatform = windowsFilePlatform{}
}

// windowsFilePlatform implements the single-file transaction for Windows.
// The running executable locks its image, so the running process persists
// the activated phase before any mutation and hands the swap to a helper
// copy placed outside the replaced path; the helper waits for the old
// process to exit, then backs up, swaps, launches, acknowledges, and — on
// any failure — restores the old executable.
type windowsFilePlatform struct{}

// activate persists the activated phase and its health deadline before any
// mutation happens: on Windows the mutations run in the helper after the
// old process exits, so the durable record must lead them.
func (windowsFilePlatform) activate(i *Installer, op Operation, payload *Payload) (Operation, error) {
	op.Phase = PhaseActivated
	op.Deadline = i.now().Add(i.HealthTimeout)
	if err := i.journal.Save(op); err != nil {
		return Operation{}, fmt.Errorf("activate: persist activated phase: %w", err)
	}
	return op, nil
}

// handoff copies the verified staged executable to a unique helper path
// outside the replaced live path and runs it in helper mode, detached. The
// caller must exit promptly so the helper can wait for the old process,
// swap, launch, acknowledge, and roll back.
func (windowsFilePlatform) handoff(i *Installer, op Operation, payload *Payload) error {
	helperPath := filepath.Join(payload.Dir, "helper-"+op.ID+".exe")
	if err := copyExecutable(payload.Executable, helperPath); err != nil {
		return fmt.Errorf("handoff: stage helper copy: %w", err)
	}
	op.StagedPaths = append(op.StagedPaths, helperPath)
	if err := i.journal.Save(op); err != nil {
		return fmt.Errorf("handoff: persist helper path: %w", err)
	}
	env := append(cleanEnvironment(), helperEnv(i)...)
	env = append(
		env,
		helperLiveEnv+"="+i.Executable,
		helperBundleEnv+"="+i.BundlePath,
		helperStagedEnv+"="+payload.Executable,
	)
	if _, err := spawnDetached(helperPath, env); err != nil {
		return fmt.Errorf("handoff: start update helper: %w", err)
	}
	return nil
}

// rollback renames the backup over the live path and persists the
// rolled-back phase with next-startup suppression. A failed restore leaves
// the backup in place and records the failure: the installation stays
// recoverable.
func (windowsFilePlatform) rollback(i *Installer, op Operation, reason string) error {
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

// runHelper waits for the old process to exit, preserves the previous
// executable as a same-volume hard link — the live path is never renamed
// away, so there is never a moment without an executable at the live path —
// then moves the staged executable into place with a single rename, launches
// the new installation, and waits a bounded time for its health
// acknowledgement. On launch failure or acknowledgement timeout or early
// death it restores the backup over the live path and relaunches the
// previous installation with startup-update suppression for this recovery
// only.
func (windowsFilePlatform) runHelper(ctx context.Context, installer *Installer, journal *Journal, op Operation, parentPID int) error {
	if err := waitProcessExit(ctx, parentPID, parentExitTimeout); err != nil {
		return fmt.Errorf("helper: %w", err)
	}
	stagedPath := os.Getenv(helperStagedEnv)
	if stagedPath == "" {
		return errors.New("helper: missing staged executable path")
	}
	// The old process has exited, so the image lock is gone and the live
	// path can be linked and replaced without ever disappearing.
	if err := backupFile(installer.Executable, op.Backup); err != nil {
		return fmt.Errorf("helper: back up previous executable: %w", err)
	}
	if err := syncDir(installer.journal.dir); err != nil {
		return fmt.Errorf("helper: flush install directory: %w", err)
	}
	if err := os.Rename(stagedPath, installer.Executable); err != nil {
		// The rename failed without touching the live path: the previous
		// installation is intact and the hard-link backup is mere debris
		// that the next startup recovery cleans up.
		return fmt.Errorf("helper: install staged executable: %w", err)
	}
	if err := syncDir(installer.journal.dir); err != nil {
		return fmt.Errorf("helper: flush install directory: %w", err)
	}
	if err := os.Chmod(installer.Executable, 0o755); err != nil {
		return fmt.Errorf("helper: stage executable mode: %w", err)
	}
	child, err := spawnDetached(installer.Executable, cleanEnvironment())
	if err != nil {
		// The new installation never launched: restore the old executable.
		if restoreErr := restoreFile(op.Backup, installer.Executable); restoreErr != nil {
			return errors.Join(err, restoreErr)
		}
		if launchErr := relaunchPrevious(installer.Executable); launchErr != nil {
			return errors.Join(err, launchErr)
		}
		return err
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

// backupFile preserves the previous executable content at backupPath
// without moving the live path. A hard link keeps it instant and atomic
// even while the image is locked; filesystems without links fall back to a
// streamed copy.
func backupFile(livePath, backupPath string) error {
	if err := os.Link(livePath, backupPath); err == nil {
		return syncDir(filepath.Dir(livePath))
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

// copyExecutable copies a verified executable for helper use, preserving
// the executable bit.
func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	if copyErr == nil {
		copyErr = out.Sync()
	}
	if closeErr := out.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		os.Remove(dst)
		return copyErr
	}
	return syncDir(filepath.Dir(dst))
}

// restoreFile renames the backup over the live path.
func restoreFile(backupPath, livePath string) error {
	if err := os.Rename(backupPath, livePath); err != nil {
		return fmt.Errorf("restore backup: %w", err)
	}
	return syncDir(filepath.Dir(livePath))
}

// lockExclusive takes exclusive, non-blocking ownership of the operation
// lock file.
func lockExclusive(file *os.File) error {
	overlapped := new(windows.Overlapped)
	return windows.LockFileEx(windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 0, ^uint32(0), overlapped)
}

// unlockExclusive releases the operation lock.
func unlockExclusive(file *os.File) error {
	overlapped := new(windows.Overlapped)
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 0, ^uint32(0), overlapped)
}

// syncDir flushes a directory's metadata via a backup-semantics handle.
func syncDir(dir string) error {
	handle, err := windows.CreateFile(windows.StringToUTF16Ptr(dir),
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fmt.Errorf("open directory: %w", err)
	}
	defer windows.CloseHandle(handle)
	if err := windows.FlushFileBuffers(handle); err != nil {
		return fmt.Errorf("flush directory: %w", err)
	}
	return nil
}

// spawnDetached starts path detached from this console and process group,
// with env replacing the environment entirely.
func spawnDetached(path string, env []string) (*detachedProcess, error) {
	cmd := exec.Command(path)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
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

// processAlive reports whether a process with pid still exists.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	windows.CloseHandle(handle)
	return true
}

// waitProcessExit blocks until pid no longer exists or the timeout passes.
// A zero pid (unknown parent) returns immediately.
func waitProcessExit(ctx context.Context, pid int, timeout time.Duration) error {
	if pid <= 0 {
		return nil
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil // the process is already gone
	}
	defer windows.CloseHandle(handle)
	deadline := time.Now().Add(timeout)
	for {
		if ctx.Err() != nil {
			return fmt.Errorf("wait for process %d: %w", pid, ctx.Err())
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("process %d did not exit within %s", pid, timeout)
		}
		if remaining > time.Minute {
			remaining = time.Minute
		}
		event, waitErr := windows.WaitForSingleObject(handle, uint32(remaining.Milliseconds()))
		if waitErr == nil && event == windows.WAIT_OBJECT_0 {
			return nil
		}
		if waitErr != syscall.Errno(windows.WAIT_TIMEOUT) && waitErr != windows.ERROR_SUCCESS {
			return fmt.Errorf("wait for process %d: %w", pid, waitErr)
		}
		sleep(ctx, ackPollInterval)
	}
}
