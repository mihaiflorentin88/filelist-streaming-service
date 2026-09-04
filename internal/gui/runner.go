//go:build !(linux && arm)

package gui

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/datadir"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/singleinstance"
)

// settingsPathEnv keeps its historic precedence (spec: Data directory):
// when set, both serve and the GUI load the settings file it points at;
// otherwise the file lives at <resolved data dir>/settings.json.
const settingsPathEnv = config.EnvironmentPrefix + "SETTINGS_PATH"

// Run assembles and runs the Wails desktop app: data-dir resolution,
// settings load, single-instance forwarding, the supervisor (which anchors
// the relative default paths on first successful start), the window, the
// tray, and the state-event wiring. All Wails usage is confined to this
// package so a framework migration touches one boundary (spec: Risks).
func Run(opts Options) error {
	// Headless Linux must exit with the serve direction, never a raw GTK
	// init error. Windows/macOS always have a session; failures surface
	// from Run below.
	if runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return ErrNoDisplay
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dir, source, err := datadir.Resolve(opts.DataDir, exe)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create data dir %s: %w", dir, err)
	}
	settingsPath := os.Getenv(settingsPathEnv)
	if settingsPath == "" {
		settingsPath = filepath.Join(dir, "settings.json")
	}
	settings, err := config.LoadAt(settingsPath)
	if err != nil {
		return err
	}

	lock, err := singleinstance.Acquire(dir)
	if err != nil {
		if errors.Is(err, singleinstance.ErrAlreadyRunning) {
			// The "show" forward already reached the running instance; a
			// second launch has done its job.
			return nil
		}
		return err
	}
	defer lock.Close()

	log, closeLog, err := newGUILogger(dir)
	if err != nil {
		return err
	}
	defer closeLog()

	sup := NewSupervisor(SupervisorDeps{
		Log:      log,
		Settings: settings,
		CanStart: func() error {
			if missing := settings.MissingRequired(); len(missing) > 0 {
				return fmt.Errorf("required settings missing: %s", strings.Join(missing, ", "))
			}
			return nil
		},
	})
	// Anchor-on-start (not at boot): a boot-time Save would mark the
	// default downloadRoot file-provided and shrink first-run setup from
	// three missing keys to two. The factory runs only after CanStart
	// passes — the required keys are genuinely provided by then — so
	// anchoring the relative defaults and persisting there is truthful, and
	// the default factory's composition.NewAt reloads the anchored file.
	baseFactory := sup.appFactory
	sup.appFactory = func() (appLike, error) {
		if err := anchorDefaultPaths(settings, dir); err != nil {
			return nil, err
		}
		return baseFactory()
	}
	bind := &Bindings{settings: settings, sup: sup, dataDir: dir, dataDirSource: source}

	app := application.New(application.Options{
		Name:   "FileList Streaming",
		Assets: application.AssetOptions{Handler: assetHandler()},
		Services: []application.Service{
			application.NewService(bind),
		},
		// The pinned beta's teardown hook: every quit path (tray Quit,
		// Cmd+Q via the app menu, window-less termination) funnels into
		// App.cleanup, which runs OnShutdown first and blocks until it
		// returns — so the server (engine + sqlite) closes before the
		// process dies. lock.Close removes gui.lock even though Run never
		// returns on macOS ([NSApp terminate:] exits first).
		OnShutdown: func() {
			_ = sup.Stop()
			_ = lock.Close()
		},
	})

	// The pinned beta installs no application menu: without this, macOS
	// has no Cmd+Q / app menu Quit at all. The role menu carries the
	// standard Quit item (NewQuitMenuItem -> globalApplication.Quit()).
	if runtime.GOOS == "darwin" {
		app.Menu.SetApplicationMenu(application.NewMenu().
			AddRole(application.AppMenu).
			AddRole(application.EditMenu).
			AddRole(application.WindowMenu))
	}

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "FileList Streaming",
		Width:     1100,
		Height:    720,
		MinWidth:  960,
		MinHeight: 600,
		URL:       "/",
		Hidden:    opts.Minimized,
	})
	// Close-to-tray: the pinned beta registers its own WindowClosing
	// listener in NewWindow that unconditionally destroys the window, and
	// listener order would make it win over a plain OnWindowEvent hide.
	// Hooks run before listeners and a cancelled event skips them all
	// (webview_window.go HandleWindowEvent), so cancel + hide keeps the
	// app alive with only the tray left.
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		e.Cancel()
		win.Hide()
	})

	tray := newTray(app, win, sup, bind)
	lock.OnShow(func() { win.Show() })
	sup.OnStateChange(func(s State, sErr error) {
		app.Event.Emit("server:state", newStateEvent(s, sErr, sup.Address()))
		tray.Refresh(s)
	})
	// Boot emit: arrives before the webview loads, so the frontend also
	// seeds from the ServerState binding at startup (desktop/src/main.tsx).
	app.Event.Emit("server:state", newStateEvent(sup.State(), sup.Error(), sup.Address()))

	app.Run()
	return nil
}

// newStateEvent shapes the payload carried by the 'server:state' topic;
// the TS mirror is desktop/src/lib/state.ts.
func newStateEvent(s State, sErr error, address string) StateEvent {
	ev := StateEvent{State: s, Address: address}
	if sErr != nil {
		ev.Error = sErr.Error()
	}
	return ev
}

// newGUILogger writes JSON lines to <data dir>/logs/server.jsonl. The GUI
// has no meaningful console; the file is the only sink.
func newGUILogger(dir string) (*slog.Logger, func(), error) {
	logDir := filepath.Join(dir, "logs")
	if err := os.MkdirAll(logDir, 0o750); err != nil {
		return nil, nil, fmt.Errorf("create log dir %s: %w", logDir, err)
	}
	f, err := os.OpenFile(filepath.Join(logDir, "server.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return nil, nil, fmt.Errorf("open gui log: %w", err)
	}
	return slog.New(slog.NewJSONHandler(f, nil)), func() { _ = f.Close() }, nil
}

// anchoredPaths are the settings keys whose default values are relative to
// the process CWD in serve mode. In the GUI the process CWD is arbitrary
// (launched from Finder/Dock/autostart), so a default-valued path must
// anchor to the resolved data dir instead.
var anchoredPaths = []struct {
	jsonKey string
}{
	{jsonKey: "databasePath"},
	{jsonKey: "artworkCachePath"},
	{jsonKey: "torrentSessionDir"},
}

// anchorDefaultPaths rewrites the three relative default paths
// (DatabasePath, ArtworkCachePath, TorrentSessionDir) to absolute paths
// under dir, persisting via Save. Only true defaults are touched:
// a value explicitly present in the settings file is the user's word and
// stays untouched, and an env-managed key keeps its runtime value with the
// file left to the store's managed-field restore. Serve mode is untouched:
// it keeps today's CWD anchoring.
func anchorDefaultPaths(settings *config.Store, dir string) error {
	current := settings.Get()
	defaults := config.Defaults()

	// Keys explicitly present in the settings file. The store tracks
	// file-provided state only for required keys, so this re-reads the raw
	// file for the three anchored ones. json.Unmarshal matches object keys
	// to struct fields case-insensitively, so the presence check must fold
	// case the same way.
	fileKeys := map[string]bool{}
	if b, err := os.ReadFile(settings.Path()); err == nil {
		var present map[string]json.RawMessage
		if json.Unmarshal(b, &present) == nil {
			for k := range present {
				fileKeys[strings.ToLower(k)] = true
			}
		}
	}

	anchored := current
	changed := false
	for _, a := range anchoredPaths {
		if fileKeys[strings.ToLower(a.jsonKey)] || settings.EnvironmentManaged(a.jsonKey) {
			continue
		}
		switch a.jsonKey {
		case "databasePath":
			if current.DatabasePath != defaults.DatabasePath {
				continue
			}
			anchored.DatabasePath = filepath.Join(dir, current.DatabasePath)
		case "artworkCachePath":
			if current.ArtworkCachePath != defaults.ArtworkCachePath {
				continue
			}
			anchored.ArtworkCachePath = filepath.Join(dir, current.ArtworkCachePath)
		case "torrentSessionDir":
			if current.TorrentSessionDir != defaults.TorrentSessionDir {
				continue
			}
			anchored.TorrentSessionDir = filepath.Join(dir, current.TorrentSessionDir)
		}
		changed = true
	}
	if !changed {
		return nil
	}
	if err := settings.Save(anchored); err != nil {
		return fmt.Errorf("anchor default paths to %s: %w", dir, err)
	}
	return nil
}
