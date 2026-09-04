//go:build darwin

package autostart

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDarwinEnableDisableRoundTrip(t *testing.T) {
	dir := t.TempDir()
	DarwinPlistDir = func() string { return dir }
	defer func() { DarwinPlistDir = defaultDarwinPlistDir }()

	if err := Enable(Options{ExePath: "/Applications/FileList Streaming.app/Contents/MacOS/filelist-streaming", Args: []string{"--minimized", "--data-dir", "/opt/fs/data"}}); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "com.filelist-streaming.plist"))
	if err != nil {
		t.Fatalf("plist: %v", err)
	}
	text := string(b)
	for _, want := range []string{
		"com.filelist-streaming",
		"<key>RunAtLoad</key>",
		"<true/>",
		"<key>KeepAlive</key>",
		"<false/>",
		"<string>/Applications/FileList Streaming.app/Contents/MacOS/filelist-streaming</string>",
		"<string>--minimized</string>",
		"<string>--data-dir</string>",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("plist missing %q in:\n%s", want, text)
		}
	}
	if ok, err := Enabled(); err != nil || !ok {
		t.Fatalf("Enabled after Enable = %v, %v", ok, err)
	}
	if err := Disable(); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if ok, err := Enabled(); err != nil || ok {
		t.Fatalf("Enabled after Disable = %v, %v", ok, err)
	}
	if err := Disable(); err != nil { // idempotent
		t.Fatalf("Disable must tolerate absence: %v", err)
	}
}
