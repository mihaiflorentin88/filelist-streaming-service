package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

var (
	errFakeGUI   = errors.New("fake gui")
	errFakeServe = errors.New("fake serve")
)

func TestRestartRequiredMovedFromHandler(t *testing.T) {
	// Guards the moved helper: handler contract from api.go stays identical.
	old := config.Defaults()
	next := old
	next.ListenAddress = ":1"
	if !config.RestartRequired(old, next) {
		t.Fatal("listener change must require restart")
	}
}

func TestRootRejectsMinimizedOutsideGUI(t *testing.T) {
	root := newRootCommand(func(opts guiOptions) error {
		return errFakeGUI
	}, func(dataDir string, l logger) error { return errFakeServe })
	root.SetArgs([]string{"--minimized"})
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	err := root.Execute()
	if err == nil || !strings.Contains(out.String(), "serve") {
		t.Fatalf("bare run without GUI support must direct to serve, got err=%v out=%q", err, out.String())
	}
}

func TestServeResolvesDataDirBeforeRunner(t *testing.T) {
	// The serve path must resolve --data-dir (datadir.Resolve + mkdir) and
	// point the log file under it BEFORE the serve runner starts, so the
	// injected runner observes the resolved directory.
	flagDir := filepath.Join(t.TempDir(), "data")
	var got string
	root := newRootCommand(func(guiOptions) error { return errFakeGUI }, func(dataDir string, l logger) error {
		got = dataDir
		return errFakeServe
	})
	root.SetArgs([]string{"serve", "--data-dir", flagDir})
	if err := root.Execute(); !errors.Is(err, errFakeServe) {
		t.Fatalf("serve must run the injected serve runner, got err=%v", err)
	}
	if got != flagDir {
		t.Fatalf("runServe must receive the resolved data dir %q, got %q", flagDir, got)
	}
	if _, err := os.Stat(flagDir); err != nil {
		t.Fatalf("data dir must exist before the serve runner starts: %v", err)
	}
}
