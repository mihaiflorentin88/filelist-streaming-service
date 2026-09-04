package gui

// Options carries the GUI launch flags: --minimized boots to the tray
// only, --data-dir pins the data directory (same resolution as serve).
// It lives outside the build-tagged files so both the Wails runner and
// the linux/arm fallback share one signature.
type Options struct {
	Minimized bool
	DataDir   string
}
