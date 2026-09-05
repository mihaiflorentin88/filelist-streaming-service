//go:build unix

package singleinstance

import (
	"errors"
	"syscall"
)

// defaultPidAlive reports whether a lock-owner pid still runs: signal 0
// checks liveness without delivering anything. nil means the process
// exists; EPERM means it exists under another user — alive for takeover
// purposes either way. ESRCH is the dead-owner proof that breaks a stale
// lock.
func defaultPidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
