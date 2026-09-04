package composition

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestNewAtLoadsExplicitPath pins the constructor serve and the GUI
// supervisor share: the explicit path wins over the environment, so the
// settings store is exactly the file the caller resolved.
func TestNewAtLoadsExplicitPath(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	body := `{"databasePath": "` + filepath.Join(dir, "test.db") + `",` +
		` "torrentSessionDir": "` + filepath.Join(dir, "torrent") + `",` +
		` "artworkCachePath": "` + filepath.Join(dir, "artwork") + `",` +
		` "downloadRoot": "` + filepath.Join(dir, "downloads") + `"}`
	if err := os.WriteFile(settingsPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EnvironmentPrefix+"SETTINGS_PATH", filepath.Join(dir, "not-this.json"))

	app, err := NewAt(settingsPath, testLogger())
	if err != nil {
		t.Fatalf("NewAt: %v", err)
	}
	defer app.Close()
	if got := app.Settings.Path(); got != settingsPath {
		t.Fatalf("NewAt must load the explicit path %q, got %q", settingsPath, got)
	}
}

// TestNewAtEnvManagedPathsWin pins the other half of the precedence
// contract: an env-set setting overrides the file's value at runtime
// (LoadAt semantics), while the file keeps carrying what was written.
func TestNewAtEnvManagedPathsWin(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	body := `{"databasePath": "` + filepath.Join(dir, "from-file.db") + `",` +
		` "torrentSessionDir": "` + filepath.Join(dir, "torrent") + `",` +
		` "artworkCachePath": "` + filepath.Join(dir, "artwork") + `",` +
		` "downloadRoot": "` + filepath.Join(dir, "downloads") + `"}`
	if err := os.WriteFile(settingsPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	envDB := filepath.Join(dir, "from-env.db")
	t.Setenv(config.EnvironmentPrefix+"DATABASE_PATH", envDB)

	app, err := NewAt(settingsPath, testLogger())
	if err != nil {
		t.Fatalf("NewAt: %v", err)
	}
	defer app.Close()
	if got := app.Settings.Get().DatabasePath; got != envDB {
		t.Fatalf("env-managed databasePath must win at runtime, got %q", got)
	}
	if !strings.Contains(app.Settings.Path(), "settings.json") {
		t.Fatalf("settings path must stay %q", settingsPath)
	}
}
