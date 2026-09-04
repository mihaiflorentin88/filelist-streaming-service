package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/composition"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/datadir"
)

// settingsPathEnv keeps its historic precedence (spec: Data directory): when
// set, composition loads the settings file it points at; otherwise the file
// lives at <resolved data dir>/settings.json.
const settingsPathEnv = "FILELIST_STREAMING_SETTINGS_PATH"

type guiOptions struct {
	Minimized bool
	DataDir   string
}

type logger interface {
	Info(msg string, args ...any)
	Warn(msg string, args ...any)
	Error(msg string, args ...any)
}

// errNoDisplay is the sentinel runGUI returns until the desktop GUI arrives;
// the root command turns it into a pointer at `serve`.
var errNoDisplay = errors.New("no display")

func isNoDisplay(err error) bool { return errors.Is(err, errNoDisplay) }

// runGUI launches the desktop GUI. Stub until the GUI entrypoint task lands:
// without a display there is nothing to open, so the root command directs
// users to the headless serve command.
func runGUI(opts guiOptions) error {
	return errNoDisplay
}

// newRootCommand separates command wiring from effects so tests can inject
// the GUI and serve runners.
func newRootCommand(runGUI func(guiOptions) error, runServe func(string, logger) error) *cobra.Command {
	var dataDir string
	var minimized bool
	root := &cobra.Command{
		Use:     "filelist-streaming",
		Short:   "FileList Streaming media server",
		Version: versionString(),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts := guiOptions{Minimized: minimized, DataDir: dataDir}
			if err := runGUI(opts); err != nil {
				if isNoDisplay(err) {
					return fmt.Errorf("no display available for the GUI; run 'filelist-streaming serve' instead")
				}
				return err
			}
			return nil
		},
	}
	root.PersistentFlags().StringVar(&dataDir, "data-dir", "", "data directory (default: data/ next to the executable)")
	root.Flags().BoolVar(&minimized, "minimized", false, "start minimized to the system tray")
	serve := &cobra.Command{
		Use:   "serve",
		Short: "run the headless streaming server",
		RunE: func(cmd *cobra.Command, args []string) error {
			attachParentConsole()
			dir, err := resolveDataDir(dataDir)
			if err != nil {
				return err
			}
			log, closeLog := newLogger(os.Stdout, isTerminal(os.Stdout), logFilePath(dir))
			defer closeLog()
			return runServe(dir, log)
		},
	}
	root.AddCommand(serve)
	return root
}

// resolveDataDir resolves the effective data directory and makes sure it
// exists before anything writes into it.
func resolveDataDir(flagDir string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir, _, err := datadir.Resolve(flagDir, exe)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("create data dir %s: %w", dir, err)
	}
	return dir, nil
}

// versionString prefers the linker-injected release version; a plain `go run`
// (no ldflags) falls back to the repo's VERSION file so dev runs report the
// release version instead of the compile-time "dev".
func versionString() string {
	if v := composition.Version; v != "" && v != "dev" {
		return v
	}
	if b, err := os.ReadFile("VERSION"); err == nil {
		if v := strings.TrimSpace(string(b)); v != "" {
			return v
		}
	}
	return composition.Version
}

// runServe is the headless server — settings resolution, composition, signal
// handling, and ListenAndServe — the former main() body, parameterized.
func runServe(dataDir string, log logger) error {
	settingsPath := os.Getenv(settingsPathEnv)
	if settingsPath == "" {
		settingsPath = filepath.Join(dataDir, "settings.json")
	}
	app, err := openComposition(settingsPath, log)
	if err != nil {
		log.Error("startup failed", "error", err)
		return err
	}
	defer app.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := app.Server.Shutdown(shutdownCtx); err != nil {
			log.Error("graceful shutdown failed", "error", err)
		}
	}()

	log.Info("server listening", "address", app.ListenAddress, "version", composition.Version, "settingsFile", app.Settings.Path())
	if err := app.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server stopped", "error", err)
		os.Exit(1)
	}
	return nil
}

// openComposition assembles the application against settingsPath.
// composition.New reads its settings path from the environment (config.Load),
// so an explicit settingsPathEnv keeps today's precedence unchanged, and when
// unset the resolved path is exported for it to pick up.
func openComposition(settingsPath string, log logger) (*composition.App, error) {
	sl, ok := log.(*slog.Logger)
	if !ok {
		return nil, fmt.Errorf("openComposition needs the process *slog.Logger, got %T", log)
	}
	if os.Getenv(settingsPathEnv) == "" {
		if err := os.Setenv(settingsPathEnv, settingsPath); err != nil {
			return nil, fmt.Errorf("export settings path: %w", err)
		}
	}
	return composition.New(sl)
}

func main() {
	root := newRootCommand(runGUI, runServe)
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
