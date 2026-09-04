//go:build headless || (linux && arm)

package gui

// Run is the GUI-less fallback: compiled in for every `headless` build and
// for linux/armv7 (the release ships pure headless there — no webkit2gtk),
// so a bare launch behaves like a GUI-less environment and the root command
// directs users to `serve`.
func Run(opts Options) error {
	return ErrNoDisplay
}
