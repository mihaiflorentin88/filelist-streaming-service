package gui

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/httpapi"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/composition"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/autostart"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/datadir"
)

// StateEvent is the server lifecycle payload the Wails runner emits on the
// 'server:state' topic and the ServerState binding returns. The TS mirror is
// desktop/src/lib/state.ts.
type StateEvent struct {
	State   State  `json:"state"`
	Error   string `json:"error,omitempty"`
	Address string `json:"address,omitempty"`
}

// SaveResult is the SaveSettings response: whether the settings persisted,
// whether any restart-required field changed, and whether the save completed
// setup and auto-started the server.
type SaveResult struct {
	Saved           bool `json:"saved"`
	RestartRequired bool `json:"restartRequired"`
	AutoStarted     bool `json:"autoStarted"`
}

// Bindings is the Wails service behind the desktop pages: server control,
// the settings transport, autostart, and data-dir helpers. The runner
// (Task 6) injects the store and supervisor it shares with the server;
// wails wraps this struct by reflection at runtime, so it stays plain Go.
type Bindings struct {
	settings *config.Store
	sup      *Supervisor
	// dataDir/dataDirSource come from the runner's datadir.Resolve; when
	// unset they resolve lazily on first use.
	dataDir       string
	dataDirSource string

	// Test seams; nil falls back to the real platform implementation.
	exePathFn        func() (string, error)
	autostartEnable  func(autostart.Options) error
	autostartDisable func() error
	autostartEnabled func() (bool, error)
	revealFn         func(path string) error
	openURLFn        func(url string) error
	quitFn           func()
}

// ServerState reports the current lifecycle state for page mounts that miss
// the last 'server:state' event.
func (b *Bindings) ServerState() StateEvent {
	ev := StateEvent{State: b.sup.State(), Address: b.sup.Address()}
	if err := b.sup.Error(); err != nil {
		ev.Error = err.Error()
	}
	return ev
}

// StartServer brings the server up (refused while required settings are
// missing; that shows setup, not failure).
func (b *Bindings) StartServer() error { return b.sup.Start() }

// StopServer gracefully shuts the running server down.
func (b *Bindings) StopServer() error { return b.sup.Stop() }

// RestartServer applies restart-required settings: Stop then Start.
func (b *Bindings) RestartServer() error { return b.sup.Restart() }

// LoadSettings returns the settings exactly as GET /api/v1/settings serves
// them: secrets blanked, Configured flags, settings file path.
func (b *Bindings) LoadSettings() httpapi.SettingsView {
	v := b.settings.Get()
	return httpapi.RedactedSettings(v, b.settings.Path())
}

// SaveSettings mirrors the HTTP PUT /api/v1/settings contract: native-path
// probe, secrets-preserving save, restart-required diff. A save that
// completes the required settings while the server is stopped auto-starts
// it (the GUI form of "starts automatically once configuration is set").
func (b *Bindings) SaveSettings(next config.Settings) (SaveResult, error) {
	old := b.settings.Get()
	wasIncomplete := len(b.settings.MissingRequired()) > 0
	if err := config.EnsureNativePathsWritable(next.DownloadEngine, next.DownloadRoot, next.TorrentSessionDir); err != nil {
		return SaveResult{}, err
	}
	if err := b.settings.Save(next); err != nil {
		return SaveResult{}, err
	}
	current := b.settings.Get()
	result := SaveResult{Saved: true, RestartRequired: config.RestartRequired(old, current)}
	if wasIncomplete && len(b.settings.MissingRequired()) == 0 && b.sup.State() == StateStopped {
		go func() { _ = b.sup.Start() }()
		result.AutoStarted = true
	}
	return result, nil
}

// SettingsSchema returns the settings schema, identical to the HTTP
// /api/v1/settings/schema items.
func (b *Bindings) SettingsSchema() []httpapi.SchemaField {
	return httpapi.SettingsSchema(b.settings)
}

// MissingRequired lists the required settings still absent; the Settings
// page banners it and deep-links the Tracker tab.
func (b *Bindings) MissingRequired() []string {
	return b.settings.MissingRequired()
}

// Version reports the server version (composition.Version, ldflags-injected
// in release builds).
func (b *Bindings) Version() string { return composition.Version }

// AutostartStatus reads the OS launch-on-boot artifact back; the OS is the
// source of truth, never memory.
func (b *Bindings) AutostartStatus() (bool, error) {
	if b.autostartEnabled != nil {
		return b.autostartEnabled()
	}
	return autostart.Enabled()
}

// EnableAutostart registers launch-on-boot: the running executable with
// --minimized --data-dir <resolved data dir>, so launches never depend on a
// working directory.
func (b *Bindings) EnableAutostart() error {
	exe, err := b.exePath()
	if err != nil {
		return err
	}
	dir, _ := b.dataDirInfo()
	if b.autostartEnable != nil {
		return b.autostartEnable(autostart.Options{ExePath: exe, Args: []string{"--minimized", "--data-dir", dir}})
	}
	return autostart.Enable(autostart.Options{ExePath: exe, Args: []string{"--minimized", "--data-dir", dir}})
}

// DisableAutostart removes the OS launch-on-boot artifact.
func (b *Bindings) DisableAutostart() error {
	if b.autostartDisable != nil {
		return b.autostartDisable()
	}
	return autostart.Disable()
}

// DataDirInfo returns the resolved data directory and where it came from
// ("flag", "pointer", or "default").
func (b *Bindings) DataDirInfo() (string, string) {
	return b.dataDirInfo()
}

// OpenPath reveals a well-known folder in the OS file manager: kind is
// "logs" (<data dir>/logs) or "data" (the data dir itself).
func (b *Bindings) OpenPath(kind string) error {
	dir, _ := b.dataDirInfo()
	if dir == "" {
		return errors.New("data directory is not resolvable yet")
	}
	var path string
	switch kind {
	case "logs":
		path = filepath.Join(dir, "logs")
	case "data":
		path = dir
	default:
		return fmt.Errorf("unknown path kind %q; want \"logs\" or \"data\"", kind)
	}
	if err := os.MkdirAll(path, 0o750); err != nil {
		return err
	}
	return b.reveal(path)
}

// OpenWebUI opens the server's web surface in the default browser. The port
// follows the running (or most recently run) server; the loopback host is
// fixed: the web UI is this machine's window onto the same server.
func (b *Bindings) OpenWebUI() error {
	address := b.sup.Address()
	if address == "" {
		address = b.settings.Get().ListenAddress
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return fmt.Errorf("server address %q has no port to open", address)
	}
	return b.openURL("http://127.0.0.1:" + port)
}

// Quit shuts the server down and exits the application. The runner may
// inject quitFn (the wails app's Quit) to run its own teardown instead.
func (b *Bindings) Quit() error {
	if b.quitFn != nil {
		b.quitFn()
		return nil
	}
	_ = b.sup.Stop()
	os.Exit(0)
	return nil
}

// exePath resolves the executable for autostart entries.
func (b *Bindings) exePath() (string, error) {
	if b.exePathFn != nil {
		return b.exePathFn()
	}
	return os.Executable()
}

// dataDirInfo returns the injected data dir, resolving lazily when the
// runner did not inject one.
func (b *Bindings) dataDirInfo() (string, string) {
	if b.dataDir != "" {
		return b.dataDir, b.dataDirSource
	}
	exe, err := b.exePath()
	if err != nil {
		return "", ""
	}
	dir, source, err := datadir.Resolve("", exe)
	if err != nil {
		return "", ""
	}
	return dir, source
}

func (b *Bindings) reveal(path string) error {
	if b.revealFn != nil {
		return b.revealFn(path)
	}
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", path).Start()
	case "windows":
		return exec.Command("explorer", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}

func (b *Bindings) openURL(url string) error {
	if b.openURLFn != nil {
		return b.openURLFn(url)
	}
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
