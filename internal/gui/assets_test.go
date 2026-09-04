package gui

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestAppIconMatchesBuildAsset pins the committed dock icon to the wails
// build asset it mirrors. build/appicon.png is the source of truth (wails3
// regenerates it and stamps the .app bundle from it), but the embed needs a
// copy inside this package; when the source icon changes, this test fails
// until the copy is refreshed, keeping the two from drifting apart.
func TestAppIconMatchesBuildAsset(t *testing.T) {
	buildIcon, err := os.ReadFile(filepath.Join("..", "..", "build", "appicon.png"))
	if err != nil {
		t.Fatalf("read build/appicon.png: %v", err)
	}
	if len(appIcon) == 0 {
		t.Fatal("internal/gui/assets/appicon.png is empty or missing from the embed")
	}
	if !bytes.Equal(buildIcon, appIcon) {
		t.Fatal("internal/gui/assets/appicon.png drifted from build/appicon.png; re-copy it")
	}
}
