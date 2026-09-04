// Package autostart manages launch-on-boot per OS. The OS artifact is the
// source of truth: Enabled() reads it back; the GUI never trusts memory.
// Entries always pin --minimized and an explicit --data-dir so launchd/XDG/
// registry launches do not depend on a working directory.
package autostart

type Options struct {
	ExePath string
	Args    []string
}

func Enable(opts Options) error { return platformEnable(opts) }
func Disable() error            { return platformDisable() }
func Enabled() (bool, error)    { return platformEnabled() }
