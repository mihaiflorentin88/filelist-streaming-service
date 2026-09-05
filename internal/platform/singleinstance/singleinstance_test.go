package singleinstance

import (
	"encoding/json"
	"errors"
	"net"
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

// TestDeadOwnerLockIsTakenOverDespiteLiveNotifyURL pins the pid-liveness
// check: a lock whose owner pid is provably dead must be broken even when
// its recorded NotifyURL answers — the port may have been recycled by an
// unrelated listener, and the old dial-only check forwarded "show" to that
// stranger and refused to start.
func TestDeadOwnerLockIsTakenOverDespiteLiveNotifyURL(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	b, err := json.Marshal(lockContents{PID: 999999, NotifyURL: ln.Addr().String()})
	if err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(dataDir, "gui.lock")
	if err := os.WriteFile(lockPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	original := pidAlive
	pidAlive = func(int) bool { return false }
	t.Cleanup(func() { pidAlive = original })

	l, err := Acquire(dataDir)
	if err != nil {
		t.Fatalf("a dead owner must break the lock even when its notify URL answers, got %v", err)
	}
	defer l.Close()
	reloaded, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	var c lockContents
	if err := json.Unmarshal(reloaded, &c); err != nil {
		t.Fatal(err)
	}
	if c.PID != os.Getpid() {
		t.Fatalf("takeover must write the current pid, got %d", c.PID)
	}
}

// TestAliveOwnerWithUnreachableNotifyURLIsTakenOver pins the complementary
// case: a live owner whose show-listener no longer answers keeps today's
// takeover behavior instead of stranding the lock forever.
func TestAliveOwnerWithUnreachableNotifyURLIsTakenOver(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(lockContents{PID: os.Getpid(), NotifyURL: "127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "gui.lock"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	original := pidAlive
	pidAlive = func(int) bool { return true }
	t.Cleanup(func() { pidAlive = original })

	l, err := Acquire(dataDir)
	if err != nil {
		t.Fatalf("an unreachable live owner must stay takeover-able, got %v", err)
	}
	defer l.Close()
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
