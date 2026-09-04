package gui

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
)

// Static holds the desktop GUI's vite build (HTML, JS, CSS). The desktop
// build wipes and rewrites internal/gui/static on every run; its npm
// postbuild step restores the committed .gitkeep so the all:static pattern
// still matches on a fresh clone that has not built the GUI yet.
//
//go:embed all:static
var Static embed.FS

// appIcon is the macOS dock / Linux taskbar icon (PNG bytes) applied via
// the wails Options.Icon on raw runs. It is a committed copy of build/
// appicon.png because //go:embed cannot reach outside this package's
// directory; assets_test.go guards the two against drift.
//
//go:embed assets/appicon.png
var appIcon []byte

// TrayIcons holds the generated tray state icons (tools/make_tray_icons.py
// output). Embed-only, so the linux/arm build — which skips the Wails tray —
// still compiles unchanged.
//
//go:embed all:assets/tray
var TrayIcons embed.FS

// assetHandler serves the embedded vite build over HTTP for the Wails
// asset server. The embed root carries the "static" directory name, so
// the handler serves the sub-FS where index.html lives at "/".
func assetHandler() http.Handler {
	static, err := fs.Sub(Static, "static")
	if err != nil {
		// all:static guarantees the subdirectory exists; this is unreachable
		// unless the embed pattern is edited.
		panic(fmt.Sprintf("gui: embedded static missing: %v", err))
	}
	return http.FileServer(http.FS(static))
}
