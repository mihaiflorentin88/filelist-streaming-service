//go:build windows

package singleinstance

// defaultPidAlive conservatively reports every pid as alive on Windows:
// without signal-0 semantics the lock's NotifyURL dial stays the staleness
// decider there, exactly as before the pid check existed.
func defaultPidAlive(int) bool { return true }
