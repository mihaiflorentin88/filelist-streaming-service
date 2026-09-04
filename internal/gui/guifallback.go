//go:build linux && arm

package gui

// Run is the armv7 fallback: the release ships pure headless there (no
// webkit2gtk), so a bare launch behaves like a GUI-less environment and
// the root command directs users to `serve`.
func Run(opts Options) error {
	return ErrNoDisplay
}
