//go:build !darwin && !linux

package gui

import "testing"

// setAutostartTestDir has no injectable artifact dir on this platform; the
// real-OS-state round-trip test skips.
func setAutostartTestDir(t *testing.T) string {
	t.Helper()
	t.Skip("no injectable autostart dir on this platform")
	return ""
}
