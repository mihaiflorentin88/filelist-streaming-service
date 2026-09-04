//go:build !headless && !(linux && arm)

package gui

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

// newRunnerStore mirrors the store Run builds: LoadAt over an explicit
// settings path, exactly as the runner does.
func newRunnerStore(t *testing.T, path string) *config.Store {
	t.Helper()
	settings, err := config.LoadAt(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return settings
}

// runnerSupervisor wires the supervisor exactly the way Run does now:
// bindings holder first, then wireSupervisor (CanStart gate over the
// CURRENT store, factory that anchors before delegating to NewAt). It is
// the testable seam of Run's boot path (no window needed).
func runnerSupervisor(settings *config.Store, dir string) *Supervisor {
	bind := &Bindings{settings: settings, dataDir: dir, dataDirSource: "default"}
	sup := wireSupervisor(bind, slog.New(slog.NewTextHandler(io.Discard, nil)))
	bind.sup = sup
	return sup
}

// waitRunning polls until the supervisor leaves starting; the factory and
// serve loop are asynchronous.
func waitRunning(t *testing.T, sup *Supervisor) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for sup.State() == StateStarting {
		if time.Now().After(deadline) {
			t.Fatalf("supervisor never left starting; state=%s err=%v", sup.State(), sup.Error())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestRunnerBootDoesNotAnchorOrSave pins fix C1, case 1: a fresh boot with
// incomplete config must NOT write the settings file (no boot-time anchor
// Save), and MissingRequired still lists all three keys — the setup banner
// under-asking was the regression.
func TestRunnerBootDoesNotAnchorOrSave(t *testing.T) {
	work := t.TempDir()
	t.Chdir(work) // relative default paths mkdir under the temp CWD, not the repo
	dir := t.TempDir()
	settings := newRunnerStore(t, filepath.Join(dir, "settings.json"))

	sup := runnerSupervisor(settings, dir)
	err := sup.Start()
	if err == nil || !strings.Contains(err.Error(), "required settings missing") {
		t.Fatalf("incomplete config must refuse Start, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("boot must not create or rewrite the settings file, stat err=%v", err)
	}
	if got := settings.MissingRequired(); len(got) != 3 {
		t.Fatalf("MissingRequired must still list all three keys, got %v", got)
	}
}

// TestRunnerStartAnchorsDefaults pins fix C1, case 2: with a complete
// config, starting the server anchors the three relative default paths
// under the data dir and persists them; required keys provided via the
// file stay as written.
func TestRunnerStartAnchorsDefaults(t *testing.T) {
	work := t.TempDir()
	t.Chdir(work)
	dir := t.TempDir()
	downloads := filepath.Join(dir, "downloads")
	body := `{` +
		`"listenAddress": ":0",` +
		`"downloadRoot": "` + downloads + `",` +
		`"fileListUsername": "user",` +
		`"fileListPasskey": "pass"` +
		`}`
	settingsPath := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := newRunnerStore(t, settingsPath)

	sup := runnerSupervisor(settings, dir)
	if err := sup.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = sup.Stop() })
	waitRunning(t, sup)

	if want := filepath.Join(dir, "data", "filelist.db"); settings.Get().DatabasePath != want {
		t.Fatalf("start must anchor databasePath to %q, got %q", want, settings.Get().DatabasePath)
	}
	if got := settings.Get().DownloadRoot; got != downloads {
		t.Fatalf("file-provided downloadRoot must stay untouched, got %q", got)
	}
	persisted, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(persisted), filepath.Join(dir, "data", "filelist.db")) {
		t.Fatalf("anchored databasePath must be persisted, got %s", persisted)
	}
	if !strings.Contains(string(persisted), downloads) {
		t.Fatalf("downloadRoot must persist verbatim, got %s", persisted)
	}
}

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
// written. The key match is case-insensitive, mirroring Go's JSON decode.
func TestAnchorDefaultPathsExplicitFileValuesUntouched(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	body := `{"DataBasePath": "data/filelist.db", "downloadRoot": "/srv/downloads"}`
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
	// Save rewrites the file with the store's canonical key casing; the
	// value itself must survive untouched (still CWD-relative).
	if !strings.Contains(string(persisted), `"databasePath": "data/filelist.db"`) {
		t.Fatalf("explicit file value must survive untouched, got %s", persisted)
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

// TestChangeDataDirPostRelocationStartUsesNewStore pins the relocation
// contract through the production wiring: ChangeDataDir (stopped), then
// Start — the real wireSupervisor factory must anchor and NewAt against
// the NEW settings path, so the server reopens its database at the moved
// location (canary: the sqlite file appears only under the new dir).
func TestChangeDataDirPostRelocationStartUsesNewStore(t *testing.T) {
	oldDir := t.TempDir()
	newDir := t.TempDir()
	body := fmt.Sprintf(`{
		"listenAddress": ":0",
		"databasePath": %q,
		"downloadRoot": %q,
		"torrentSessionDir": %q,
		"fileListUsername": "user",
		"fileListPasskey": "pass"
	}`,
		filepath.Join(oldDir, "filelist.db"),
		filepath.Join(oldDir, "downloads"),
		filepath.Join(oldDir, "torrent-session"))
	settingsPath := filepath.Join(oldDir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := newRunnerStore(t, settingsPath)

	bind := &Bindings{settings: settings, dataDir: oldDir, dataDirSource: "default"}
	sup := wireSupervisor(bind, testLogger())
	bind.sup = sup

	if err := bind.ChangeDataDir(newDir); err != nil {
		t.Fatalf("ChangeDataDir: %v", err)
	}
	store, dir, source := bind.snapshot()
	if dir != newDir || source != "pointer" {
		t.Fatalf("holder = (%s, %s), want (%s, pointer)", dir, source, newDir)
	}
	if want := filepath.Join(newDir, "filelist.db"); store.Get().DatabasePath != want {
		t.Fatalf("anchored databasePath must remap to %q, got %q", want, store.Get().DatabasePath)
	}
	if err := sup.Start(); err != nil {
		t.Fatalf("start after relocation: %v", err)
	}
	t.Cleanup(func() { _ = sup.Stop() })
	waitRunning(t, sup)

	if _, err := os.Stat(filepath.Join(newDir, "filelist.db")); err != nil {
		t.Fatalf("database must reopen at the moved location: %v", err)
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Fatalf("old data dir %s must be gone", oldDir)
	}
}

// TestCanStartRefusesWhileRelocating pins the move-window guard on the
// production wiring: while a ChangeDataDir holds the relocating flag,
// Start is refused with a relocation-in-progress error and the state stays
// untouched.
func TestCanStartRefusesWhileRelocating(t *testing.T) {
	bind := &Bindings{settings: testStore(t), dataDir: t.TempDir(), dataDirSource: "default"}
	sup := wireSupervisor(bind, testLogger())
	bind.sup = sup

	bind.mu.Lock()
	bind.relocating = true
	bind.mu.Unlock()
	err := sup.Start()
	if err == nil || !strings.Contains(err.Error(), "data directory change in progress") {
		t.Fatalf("start during relocation must be refused, got %v", err)
	}
	if sup.State() != StateStopped {
		t.Fatalf("refusal must leave the state untouched, got %s", sup.State())
	}
}
