package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/application/updates"
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
	}, func(dataDir string, update bool, l logger) error { return errFakeServe })
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
	root := newRootCommand(func(guiOptions) error { return errFakeGUI }, func(dataDir string, update bool, l logger) error {
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

// TestServeForwardsUpdateFlag pins the --update wiring: the flag reaches
// the serve runner as update-and-serve, and stays false by default.
func TestServeForwardsUpdateFlag(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"plain serve", nil, false},
		{"update and serve", []string{"--update"}, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var got bool
			root := newRootCommand(func(guiOptions) error { return errFakeGUI }, func(dataDir string, update bool, l logger) error {
				got = update
				return errFakeServe
			})
			root.SetArgs(append([]string{"serve", "--data-dir", filepath.Join(t.TempDir(), "data")}, testCase.args...))
			if err := root.Execute(); !errors.Is(err, errFakeServe) {
				t.Fatalf("serve must run the injected runner, got err=%v", err)
			}
			if got != testCase.want {
				t.Fatalf("runServe update flag = %v, want %v", got, testCase.want)
			}
		})
	}
}

// TestApplyRelaunchArgsAdoptsOriginalInvocation pins the handoff identity
// contract: a helper-relaunched process resumes the carried command line
// as its own arguments and consumes the marker exactly once; a process
// without the marker is untouched.
func TestApplyRelaunchArgsAdoptsOriginalInvocation(t *testing.T) {
	t.Setenv(updates.RelaunchArgsEnv, "")
	original := os.Args
	t.Cleanup(func() { os.Args = original })

	applyRelaunchArgs()
	if strings.Join(os.Args, " ") != strings.Join(original, " ") {
		t.Fatalf("args changed without a marker: %v", os.Args)
	}

	carried := []string{"serve", "--data-dir", filepath.Join(t.TempDir(), "data")}
	encoded, err := json.Marshal(carried)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(updates.RelaunchArgsEnv, string(encoded))
	os.Args = []string{original[0], "--update"}
	applyRelaunchArgs()
	if strings.Join(os.Args[1:], " ") != strings.Join(carried, " ") {
		t.Fatalf("relaunched args = %v, want %v", os.Args[1:], carried)
	}
	if os.Getenv(updates.RelaunchArgsEnv) != "" {
		t.Fatal("relaunch marker must be consumed, not passed on")
	}
}
