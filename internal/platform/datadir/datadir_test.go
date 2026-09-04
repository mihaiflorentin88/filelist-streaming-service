package datadir

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolvePrecedence(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "bin", "app") // binary dir: root/bin
	os.MkdirAll(filepath.Dir(exe), 0o750)
	os.WriteFile(PointerPath(exe), []byte(filepath.Join(root, "pointed")+"\n"), 0o640)

	dir, source, err := Resolve(filepath.Join(root, "flagged"), exe)
	if err != nil || dir != filepath.Join(root, "flagged") || source != "flag" {
		t.Fatalf("flag must win: dir=%q source=%q err=%v", dir, source, err)
	}
	dir, source, err = Resolve("", exe)
	if err != nil || source != "pointer" || dir != filepath.Join(root, "pointed") {
		t.Fatalf("pointer second: dir=%q source=%q err=%v", dir, source, err)
	}
	os.Remove(PointerPath(exe))
	dir, source, err = Resolve("", exe)
	if err != nil || source != "default" || dir != filepath.Join(filepath.Dir(exe), "data") {
		t.Fatalf("default last: dir=%q source=%q err=%v", dir, source, err)
	}
}

func TestRelocateRefusesNonEmptyTarget(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "app")
	from := filepath.Join(root, "data")
	to := filepath.Join(root, "elsewhere")
	os.MkdirAll(from, 0o750)
	os.WriteFile(filepath.Join(from, "settings.json"), []byte("{}"), 0o640)
	os.MkdirAll(to, 0o750)
	os.WriteFile(filepath.Join(to, "occupied.txt"), []byte("x"), 0o640)
	if err := Relocate(exe, from, to); err == nil {
		t.Fatal("relocation into a non-empty dir must be refused")
	}
	if _, err := os.Stat(filepath.Join(from, "settings.json")); err != nil {
		t.Fatal("source must stay untouched on refusal")
	}
}

func TestRelocateSameVolumeMovesAndWritesPointer(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "app")
	from := filepath.Join(root, "data")
	to := filepath.Join(root, "data2")
	os.MkdirAll(filepath.Join(from, "logs"), 0o750)
	os.WriteFile(filepath.Join(from, "settings.json"), []byte("{}"), 0o640)
	os.WriteFile(filepath.Join(from, "logs", "server.log"), []byte("hi"), 0o640)
	if err := Relocate(exe, from, to); err != nil {
		t.Fatalf("Relocate: %v", err)
	}
	if _, err := os.Stat(filepath.Join(to, "logs", "server.log")); err != nil {
		t.Fatalf("contents must move: %v", err)
	}
	if _, err := os.Stat(from); !os.IsNotExist(err) {
		t.Fatalf("source dir must be gone after same-volume move: %v", err)
	}
	if got, _, _ := Resolve("", exe); got != to {
		t.Fatalf("pointer must name the new dir, got %q", got)
	}
}
