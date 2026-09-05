package singleinstance

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

var ErrAlreadyRunning = errors.New("another instance is already running")

type lockContents struct {
	PID       int    `json:"pid"`
	NotifyURL string `json:"notifyUrl"` // 127.0.0.1:<port> the running instance listens on
}

// InstanceLock guards single-instance behavior. Acquire either claims the
// lock (starting a loopback "show" listener) or, when a live instance is
// found, forwards "show" to it and returns ErrAlreadyRunning.
type InstanceLock struct {
	path   string
	ln     net.Listener
	onShow func()
	closed bool
}

// pidAlive decides whether a lock-owner pid still runs. It is a package
// seam so tests can inject dead owners without spawning real processes.
var pidAlive = defaultPidAlive

// ownerIsDead reports whether a lock's recorded pid is provably gone. A
// dead owner breaks the lock outright — no dial, no takeover delay, and no
// false "already running" when an unrelated process has since reused the
// recorded NotifyURL port.
func ownerIsDead(c lockContents) bool {
	return c.PID > 0 && !pidAlive(c.PID)
}

func Acquire(dataDir string) (*InstanceLock, error) {
	path := filepath.Join(dataDir, "gui.lock")
	if b, err := os.ReadFile(path); err == nil {
		var c lockContents
		if json.Unmarshal(b, &c) == nil && !ownerIsDead(c) {
			if c.NotifyURL != "" {
				if conn, derr := net.DialTimeout("tcp", c.NotifyURL, time.Second); derr == nil {
					fmt.Fprintln(conn, "show")
					conn.Close()
					return nil, ErrAlreadyRunning
				}
			}
		}
		// Stale lock (owner dead, port gone, or unreadable): take over.
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	l := &InstanceLock{path: path, ln: ln}
	if err := writeLock(path, lockContents{PID: os.Getpid(), NotifyURL: ln.Addr().String()}); err != nil {
		ln.Close()
		return nil, err
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			buf := make([]byte, 16)
			conn.Read(buf)
			conn.Close()
			if l.onShow != nil {
				l.onShow()
			}
		}
	}()
	return l, nil
}

func writeLock(path string, c lockContents) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func (l *InstanceLock) OnShow(fn func()) { l.onShow = fn }

func (l *InstanceLock) Close() error {
	if l.closed {
		return nil
	}
	l.closed = true
	l.ln.Close()
	os.Remove(l.path)
	return nil
}
