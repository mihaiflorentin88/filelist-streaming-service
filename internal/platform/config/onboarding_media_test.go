package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeTool creates an executable placeholder with the given name and returns
// its path. exec.LookPath accepts it: it exists and is executable.
func fakeTool(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResolveMediaToolsFillsMissingPathsFromPATHAndPersists(t *testing.T) {
	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	probe := fakeTool(t, binDir, "ffprobe")
	convert := fakeTool(t, binDir, "ffmpeg")
	t.Setenv("PATH", binDir)

	path := filepath.Join(dir, "settings.json")
	settings := `{"ffprobePath":"/nonexistent/ffprobe","ffmpegPath":"/nonexistent/ffmpeg"}`
	if err := os.WriteFile(path, []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	store := loadAt(t, path)

	missing, err := store.ResolveMediaTools()
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 0 {
		t.Fatalf("tools reported missing despite PATH discovery: %v", missing)
	}
	got := store.Get()
	if got.FFprobePath != probe || got.FFmpegPath != convert {
		t.Fatalf("discovered paths were not applied: %#v", got)
	}

	reloaded := loadAt(t, path)
	got = reloaded.Get()
	if got.FFprobePath != probe || got.FFmpegPath != convert {
		t.Fatalf("discovered paths did not persist to %s: %#v", path, got)
	}
}

func TestResolveMediaToolsKeepsExistingUsablePaths(t *testing.T) {
	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	probe := fakeTool(t, binDir, "ffprobe")
	t.Setenv("PATH", binDir)

	path := filepath.Join(dir, "settings.json")
	settings := `{"ffprobePath":"` + probe + `","ffmpegPath":"/nonexistent/ffmpeg"}`
	if err := os.WriteFile(path, []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	store := loadAt(t, path)

	missing, err := store.ResolveMediaTools()
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get().FFprobePath; got != probe {
		t.Fatalf("an existing ffprobe path was replaced: %q", got)
	}
	if len(missing) != 1 || missing[0] != "ffmpeg" {
		t.Fatalf("expected only ffmpeg missing, got %v", missing)
	}
}

func TestResolveMediaToolsSkipsEnvironmentManagedPaths(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvironmentPrefix+"FFPROBE_PATH", "/custom/ffprobe")
	t.Setenv("PATH", dir) // no tools discoverable
	store := loadAt(t, filepath.Join(dir, "settings.json"))

	missing, err := store.ResolveMediaTools()
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range missing {
		if tool == "ffprobe" {
			t.Fatal("an environment-managed tool was reported missing")
		}
	}
	if got := store.Get().FFprobePath; got != "/custom/ffprobe" {
		t.Fatalf("an environment-managed path was overwritten: %q", got)
	}
}

func TestResolveMediaToolsReportsMissingWhenNothingFound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	settings := `{"ffprobePath":"/nonexistent/ffprobe","ffmpegPath":"/nonexistent/ffmpeg"}`
	if err := os.WriteFile(path, []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Join(dir, "empty"))
	store := loadAt(t, path)

	missing, err := store.ResolveMediaTools()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(missing, ",") != "ffprobe,ffmpeg" {
		t.Fatalf("missing tools = %v", missing)
	}
	if got := store.Get().FFprobePath; got != "/nonexistent/ffprobe" {
		t.Fatalf("settings changed despite missing tools: %q", got)
	}
}
