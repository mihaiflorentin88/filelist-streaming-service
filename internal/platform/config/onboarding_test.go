package config

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// failingReader errors on every read so a test fails loudly if the prompt
// loop tries to ask a question it must not ask.
type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("unexpected prompt read") }

func loadAt(t *testing.T, path string) *Store {
	t.Helper()
	t.Setenv(EnvironmentPrefix+"SETTINGS_PATH", path)
	store, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestMissingRequiredListsKeysAbsentFromFileAndEnvironment(t *testing.T) {
	dir := t.TempDir()
	store := loadAt(t, filepath.Join(dir, "settings.json"))
	if got := strings.Join(store.MissingRequired(), ","); got != "downloadRoot,fileListUsername,fileListPasskey" {
		t.Fatalf("MissingRequired with no settings file = %q", got)
	}

	provided := `{"downloadRoot":"/tmp/root","fileListUsername":"me","fileListPasskey":"k"}`
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(provided), 0o600); err != nil {
		t.Fatal(err)
	}
	store = loadAt(t, path)
	if got := store.MissingRequired(); len(got) != 0 {
		t.Fatalf("MissingRequired with a complete file = %v", got)
	}

	partial := `{"downloadRoot":"/tmp/root"}`
	if err := os.WriteFile(path, []byte(partial), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvironmentPrefix+"FILE_LIST_USERNAME", "envuser")
	store = loadAt(t, path)
	if got := strings.Join(store.MissingRequired(), ","); got != "fileListPasskey" {
		t.Fatalf("MissingRequired with file root and env username = %q", got)
	}
}

// TestSaveCompletingRequiredClearsMissingForTheSameStore pins that a save
// which fills every required key clears MissingRequired on the in-memory
// store — not just after a reload — so a GUI save that completes setup can
// detect completion and auto-start.
func TestSaveCompletingRequiredClearsMissingForTheSameStore(t *testing.T) {
	dir := t.TempDir()
	store := loadAt(t, filepath.Join(dir, "settings.json"))
	if missing := store.MissingRequired(); len(missing) != 3 {
		t.Fatalf("fresh store missing = %v, want all three required keys", missing)
	}
	next := store.Get()
	next.DownloadRoot = filepath.Join(dir, "downloads")
	next.TorrentSessionDir = filepath.Join(dir, "session")
	next.FileListUsername = "me"
	next.FileListPasskey = "secret"
	if err := store.Save(next); err != nil {
		t.Fatal(err)
	}
	if missing := store.MissingRequired(); len(missing) != 0 {
		t.Fatalf("missing after completing save = %v, want none", missing)
	}
}

func TestPromptRequiredPersistsAnswersIntoTheSettingsFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	store := loadAt(t, path)
	root := filepath.Join(dir, "downloads")
	out := &bytes.Buffer{}
	console := Console{
		In:  strings.NewReader(root + "\nme\n"),
		Out: out,
		Secret: func() ([]byte, error) {
			return []byte("secret"), nil
		},
	}
	if err := PromptRequired(store, console, true); err != nil {
		t.Fatal(err)
	}
	got := store.Get()
	if got.DownloadRoot != root || got.FileListUsername != "me" || got.FileListPasskey != "secret" {
		t.Fatalf("prompted values were not applied: %#v", got)
	}

	reloaded := loadAt(t, path)
	got = reloaded.Get()
	if got.DownloadRoot != root || got.FileListUsername != "me" || got.FileListPasskey != "secret" {
		t.Fatalf("answers did not persist to %s: %#v", path, got)
	}
	if keys := reloaded.MissingRequired(); len(keys) != 0 {
		t.Fatalf("reloaded store still reports missing keys: %v", keys)
	}
	for _, label := range []string{"Download root", "FileList username", "FileList passkey"} {
		if !strings.Contains(out.String(), label) {
			t.Fatalf("prompt %q was not shown; output: %q", label, out.String())
		}
	}
}

func TestPromptRequiredSkipsKeysProvidedByTheFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	file := `{"downloadRoot":"` + filepath.Join(dir, "downloads") + `","fileListUsername":"me","fileListPasskey":"k"}`
	if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	store := loadAt(t, path)
	out := &bytes.Buffer{}
	console := Console{
		In:  failingReader{},
		Out: out,
		Secret: func() ([]byte, error) {
			return nil, errors.New("unexpected secret read")
		},
	}
	if err := PromptRequired(store, console, true); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("prompts were shown despite a complete file: %q", out.String())
	}
}

func TestPromptRequiredWithoutTTYDoesNothing(t *testing.T) {
	dir := t.TempDir()
	store := loadAt(t, filepath.Join(dir, "settings.json"))
	console := Console{
		In:  failingReader{},
		Out: &bytes.Buffer{},
		Secret: func() ([]byte, error) {
			return nil, errors.New("unexpected secret read")
		},
	}
	if err := PromptRequired(store, console, false); err != nil {
		t.Fatal(err)
	}
	if got := len(store.MissingRequired()); got != 3 {
		t.Fatalf("headless run changed the missing keys: %d", got)
	}
}

func TestPromptRequiredRepromptsInvalidRootAndThenSucceeds(t *testing.T) {
	dir := t.TempDir()
	store := loadAt(t, filepath.Join(dir, "settings.json"))
	blocked := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "downloads")
	out := &bytes.Buffer{}
	console := Console{
		In:  strings.NewReader(filepath.Join(blocked, "child") + "\n" + root + "\nme\n"),
		Out: out,
		Secret: func() ([]byte, error) {
			return []byte("secret"), nil
		},
	}
	if err := PromptRequired(store, console, true); err != nil {
		t.Fatal(err)
	}
	if store.Get().DownloadRoot != root {
		t.Fatalf("valid root was not accepted: %q", store.Get().DownloadRoot)
	}
	if !strings.Contains(out.String(), "not usable") {
		t.Fatalf("the invalid root was not reported: %q", out.String())
	}
}

func TestPromptRequiredAbortsAfterThreeInvalidAnswers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	store := loadAt(t, path)
	blocked := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(blocked, "child") + "\n"
	console := Console{
		In:  strings.NewReader(bad + bad + bad),
		Out: &bytes.Buffer{},
		Secret: func() ([]byte, error) {
			return nil, errors.New("unexpected secret read")
		},
	}
	err := PromptRequired(store, console, true)
	if err == nil {
		t.Fatal("expected an error after three invalid answers")
	}
	if !strings.Contains(err.Error(), "downloadRoot") {
		t.Fatalf("abort error does not name the key: %v", err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("settings file was written despite the abort: %v", statErr)
	}
}
