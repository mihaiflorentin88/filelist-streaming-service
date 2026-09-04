package singleinstance

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSecondInstanceForwardsShow(t *testing.T) {
	dir := t.TempDir()
	first, err := Acquire(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer first.Close()
	shown := make(chan struct{}, 1)
	first.OnShow(func() { shown <- struct{}{} })

	second, err := Acquire(filepath.Join(dir, "data"))
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second acquire must report already running, got %v, %v", second, err)
	}
	select {
	case <-shown:
	case <-time.After(3 * time.Second):
		t.Fatal("running instance never received the show notification")
	}
}

func TestStaleLockIsTakenOver(t *testing.T) {
	dir := t.TempDir()
	l, err := Acquire(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	l.Close() // releases; next Acquire must succeed
	l2, err := Acquire(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatalf("re-acquire after close: %v", err)
	}
	l2.Close()
}

func TestLockFilePermissionsAndContents(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	l, err := Acquire(dataDir)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer l.Close()

	info, err := os.Stat(filepath.Join(dataDir, "gui.lock"))
	if err != nil {
		t.Fatalf("stat lock file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("lock file perms = %o, want 600", perm)
	}
	b, err := os.ReadFile(filepath.Join(dataDir, "gui.lock"))
	if err != nil {
		t.Fatalf("read lock file: %v", err)
	}
	var c struct {
		PID       int    `json:"pid"`
		NotifyURL string `json:"notifyUrl"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatalf("parse lock contents: %v", err)
	}
	if c.PID != os.Getpid() || c.NotifyURL == "" {
		t.Fatalf("lock contents = %+v", c)
	}
}
