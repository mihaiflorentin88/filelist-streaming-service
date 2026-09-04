package gui

import "embed"

// Static holds the desktop GUI's vite build (HTML, JS, CSS). The desktop
// build wipes and rewrites internal/gui/static on every run; its npm
// postbuild step restores the committed .gitkeep so the all:static pattern
// still matches on a fresh clone that has not built the GUI yet.
//
//go:embed all:static
var Static embed.FS
