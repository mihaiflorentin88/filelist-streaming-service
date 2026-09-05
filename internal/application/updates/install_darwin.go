//go:build darwin

package updates

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func init() {
	verifyBundleSignature = codesignVerifyStrict
	bundlePlatform = darwinBundlePlatform{}
}

// darwinBundlePlatform implements the macOS bundle transaction: atomic
// directory exchange, helper handoff outside the replaced bundle, and the
// bundle helper flow.
type darwinBundlePlatform struct{}

// codesignVerifyStrict verifies a staged bundle's code signature with
// `codesign --verify --deep --strict`. It never re-signs and never touches
// quarantine attributes: whatever the release published must verify as-is.
func codesignVerifyStrict(bundle string) error {
	cmd := exec.Command("codesign", "--verify", "--deep", "--strict", bundle)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, bytes.TrimSpace(output))
	}
	return nil
}

// activate swaps the staged bundle with the live bundle using the atomic
// directory exchange (renamex_np RENAME_SWAP): there is never a moment
// without a complete bundle at the live path. When the filesystem does not
// support the exchange, the operation is declared manual-only rather than
// silently leaving a crash-unsafe directory gap.
func (darwinBundlePlatform) activate(i *Installer, op Operation, payload *Payload) (Operation, error) {
	if err := exchangeDirs(payload.Bundle, i.BundlePath); err != nil {
		return Operation{}, fmt.Errorf("%w: atomic directory exchange unavailable: %v", ErrManualOnly, err)
	}
	// After the exchange the previous bundle lives at the staged path; the
	// journal's backup field already carries it.
	op.Phase = PhaseActivated
	op.Deadline = i.now().Add(i.HealthTimeout)
	if err := i.journal.Save(op); err != nil {
		return Operation{}, fmt.Errorf("activate: persist activated phase: %w", err)
	}
	return op, nil
}

// handoff transfers the transaction to the helper: a copy of the verified
// staged bundle's launcher, placed outside the replaced bundle, re-executed
// in helper mode and detached. The caller must exit promptly on success so
// the helper can complete swap, launch, acknowledgement, and rollback.
func (darwinBundlePlatform) handoff(i *Installer, op Operation, payload *Payload) error {
	helperPath := filepath.Join(payload.Dir, "helper-"+op.ID)
	if err := copyExecutable(executableInBundle(payload.Bundle), helperPath); err != nil {
		return fmt.Errorf("handoff: stage helper copy: %w", err)
	}
	op.StagedPaths = append(op.StagedPaths, helperPath)
	if err := i.journal.Save(op); err != nil {
		return fmt.Errorf("handoff: persist helper path: %w", err)
	}
	env := append(cleanEnvironment(), helperEnv(i)...)
	env = append(
		env,
		helperLiveEnv+"="+executableInBundle(i.BundlePath),
		helperBundleEnv+"="+i.BundlePath,
	)
	if _, err := spawnDetached(helperPath, env); err != nil {
		return fmt.Errorf("handoff: start update helper: %w", err)
	}
	return nil
}

// rollback restores the previous bundle by exchanging the directories back.
// A failed exchange keeps the previous content recoverable at the recorded
// backup path and records the failure.
func (darwinBundlePlatform) rollback(i *Installer, op Operation, reason string) error {
	restoreErr := exchangeDirs(op.Backup, i.BundlePath)
	op.Phase = PhaseRolledBack
	op.SuppressNext = true
	if restoreErr != nil {
		op.FailedError = fmt.Sprintf("%s: %v", reason, restoreErr)
	}
	if err := i.journal.Save(op); err != nil {
		return fmt.Errorf("rollback: persist rolled-back phase: %v (restore: %v)", err, restoreErr)
	}
	if restoreErr != nil {
		return fmt.Errorf("rollback: restore previous bundle: %w", restoreErr)
	}
	return nil
}

// liveIsNew reads the live bundle's CFBundleShortVersionString as the
// activation marker.
func (darwinBundlePlatform) liveIsNew(i *Installer, op Operation) bool {
	return bundleLiveVersion(i.BundlePath) == op.Version
}

// runHelper waits for the old process to exit, launches the new bundle,
// waits a bounded time for health acknowledgement, and rolls back —
// exchanging the directories back and relaunching the previous bundle with
// startup-update suppression — on timeout or early death.
func (darwinBundlePlatform) runHelper(ctx context.Context, installer *Installer, journal *Journal, op Operation, parentPID int) error {
	if err := waitProcessExit(ctx, parentPID, parentExitTimeout); err != nil {
		return fmt.Errorf("helper: %w", err)
	}
	child, err := spawnDetached(installer.Executable, cleanEnvironment())
	if err != nil {
		// The new bundle never started: exchange back and relaunch the
		// previous one.
		if rollbackErr := installer.Rollback(op, "helper launch failed"); rollbackErr == nil {
			if _, launchErr := spawnDetached(installer.Executable, cleanEnvironment()); launchErr != nil {
				return errors.Join(rollbackErr, fmt.Errorf("helper: relaunch previous: %w", launchErr))
			}
		}
		return err
	}
	if err := awaitHealth(ctx, installer, journal, child); err != nil {
		rollbackErr := installer.Rollback(op, err.Error())
		if rollbackErr == nil {
			if _, launchErr := spawnDetached(installer.Executable, cleanEnvironment()); launchErr != nil {
				return errors.Join(rollbackErr, fmt.Errorf("helper: relaunch previous: %w", launchErr))
			}
		}
		return rollbackErr
	}
	return installer.Cleanup(op)
}

// bundleLiveVersion reads the live bundle's CFBundleShortVersionString, or
// "" when unreadable.
func bundleLiveVersion(bundlePath string) string {
	info, err := readBundleInfo(filepath.Join(bundlePath, "Contents", "Info.plist"))
	if err != nil {
		return ""
	}
	return info.ShortVersion
}

// executableInBundle derives the launcher path from the bundle's recorded
// CFBundleExecutable, falling back to the release payload name.
func executableInBundle(bundlePath string) string {
	if info, err := readBundleInfo(filepath.Join(bundlePath, "Contents", "Info.plist")); err == nil && info.Executable != "" {
		return filepath.Join(bundlePath, "Contents", "MacOS", info.Executable)
	}
	return filepath.Join(bundlePath, "Contents", "MacOS", payloadBaseName)
}

// exchangeDirs atomically swaps two directory entries on the same
// filesystem. It requires renamex_np RENAME_SWAP support and fails closed
// where the filesystem lacks it.
func exchangeDirs(a, b string) error {
	return unix.RenamexNp(a, b, unix.RENAME_SWAP)
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
