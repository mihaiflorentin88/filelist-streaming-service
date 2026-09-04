//go:build !(linux && arm)

package gui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

// TestAnchorDefaultPathsDefaultsAnchored pins ruling 3, case 1: a fresh
// data dir (no settings file) means all three relative default paths anchor
// to the resolved data dir and the result is persisted via Save.
func TestAnchorDefaultPathsDefaultsAnchored(t *testing.T) {
	dir := t.TempDir()
	settings, err := config.LoadAt(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := anchorDefaultPaths(settings, dir); err != nil {
		t.Fatalf("anchor: %v", err)
	}
	got := settings.Get()
	wantDB := filepath.Join(dir, "data", "filelist.db")
	if got.DatabasePath != wantDB {
		t.Fatalf("databasePath must anchor to %q, got %q", wantDB, got.DatabasePath)
	}
	if want := filepath.Join(dir, "data", "artwork"); got.ArtworkCachePath != want {
		t.Fatalf("artworkCachePath must anchor to %q, got %q", want, got.ArtworkCachePath)
	}
	if want := filepath.Join(dir, "data", "torrent-session"); got.TorrentSessionDir != want {
		t.Fatalf("torrentSessionDir must anchor to %q, got %q", want, got.TorrentSessionDir)
	}
	// Persisted: the saved file carries the anchored values.
	persisted, err := os.ReadFile(settings.Path())
	if err != nil {
		t.Fatalf("settings file must exist after anchoring: %v", err)
	}
	if !strings.Contains(string(persisted), wantDB) {
		t.Fatalf("persisted settings must carry the anchored databasePath %q, got %s", wantDB, persisted)
	}
}

// TestAnchorDefaultPathsExplicitFileValuesUntouched pins ruling 3, case 2:
// a settings file that explicitly carries a value (even the relative
// default) is the user's word — the store value and the file stay as
// written.
func TestAnchorDefaultPathsExplicitFileValuesUntouched(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	body := `{"databasePath": "data/filelist.db", "downloadRoot": "/srv/downloads"}`
	if err := os.WriteFile(settingsPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.LoadAt(settingsPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := anchorDefaultPaths(settings, dir); err != nil {
		t.Fatalf("anchor: %v", err)
	}
	if got := settings.Get().DatabasePath; got != "data/filelist.db" {
		t.Fatalf("explicit file value must stay CWD-anchored, got %q", got)
	}
	persisted, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(persisted), `"databasePath": "data/filelist.db"`) {
		t.Fatalf("explicit file value must survive verbatim, got %s", persisted)
	}
}

// TestAnchorDefaultPathsEnvUntouched pins ruling 3, case 3: an env-managed
// key keeps its runtime value; anchoring neither rewrites it to the data
// dir nor drops the env override.
func TestAnchorDefaultPathsEnvUntouched(t *testing.T) {
	dir := t.TempDir()
	envDB := filepath.Join(dir, "env.db")
	t.Setenv(config.EnvironmentPrefix+"DATABASE_PATH", envDB)
	settings, err := config.LoadAt(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := anchorDefaultPaths(settings, dir); err != nil {
		t.Fatalf("anchor: %v", err)
	}
	if got := settings.Get().DatabasePath; got != envDB {
		t.Fatalf("env-managed databasePath must keep its runtime value, got %q", got)
	}
	// The other two defaults still anchor — the env key is the exception,
	// not a bypass.
	if want := filepath.Join(dir, "data", "artwork"); settings.Get().ArtworkCachePath != want {
		t.Fatalf("artworkCachePath must still anchor to %q, got %q", want, settings.Get().ArtworkCachePath)
	}
}
