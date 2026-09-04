package composition

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/filelist"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/httpapi"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/mediaprobe"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/nativetorrent"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/qbittorrent"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/sqlite"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/subtitles"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/tmdb"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/application"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
	"golang.org/x/term"
)

var Version = "dev"

type App struct {
	Server        *http.Server
	Settings      *config.Store
	Repository    *sqlite.Repository
	Engine        io.Closer
	ListenAddress string
}

// NewAt assembles the application against an explicit settings file path;
// the data-dir layer resolves that path before calling (env
// FILELIST_STREAMING_SETTINGS_PATH wins only because callers pass
// env-if-set-else-resolved). Both the headless server and the GUI
// supervisor build through this constructor so there is exactly one
// settings store per process.
func NewAt(settingsPath string, log *slog.Logger) (*App, error) {
	settings, err := config.LoadAt(settingsPath)
	if err != nil {
		return nil, err
	}
	return assemble(settings, log)
}

// assemble builds the application around an already-loaded settings store:
// onboarding, media-tool discovery, and every adapter wiring step.
func assemble(settings *config.Store, log *slog.Logger) (*App, error) {
	// First-run onboarding: when a required setting is neither in the
	// settings file nor the environment, ask for it before the engine is
	// built, so an unwritable default download root becomes a question
	// instead of a crash loop. Headless runs cannot answer and fall back
	// to the defaults with a warning.
	if missing := settings.MissingRequired(); len(missing) > 0 {
		if term.IsTerminal(int(os.Stdin.Fd())) {
			console := config.Console{
				In:  os.Stdin,
				Out: os.Stdout,
				Secret: func() ([]byte, error) {
					return term.ReadPassword(int(os.Stdin.Fd()))
				},
			}
			if err := config.PromptRequired(settings, console, true); err != nil {
				return nil, err
			}
		} else {
			log.Warn("required settings missing; continuing with defaults", "settings", strings.Join(missing, ", "))
		}
	}
	// Media tools: discover ffprobe/ffmpeg on PATH when the configured
	// paths do not exist, persisting what is found. A missing tool only
	// degrades subtitle probing and audio fallback at runtime, so warn
	// instead of failing startup.
	unfound, err := settings.ResolveMediaTools()
	if err != nil {
		return nil, err
	}
	if len(unfound) > 0 {
		log.Warn("media tools not found; subtitle probing and audio fallback are unavailable",
			"tools", strings.Join(unfound, ", "),
			"hint", "install ffmpeg (brew install ffmpeg, apt install ffmpeg) or set the paths in Settings")
	}
	current := settings.Get()
	repo, err := sqlite.Open(current.DatabasePath)
	if err != nil {
		return nil, err
	}
	fl := filelist.New(func() (string, string, string) {
		v := settings.Get()
		return v.FileListURL, v.FileListUsername, v.FileListPasskey
	})
	var engine application.TorrentEngine
	var engineCloser io.Closer
	routePrefix := "qb:"
	switch current.DownloadEngine {
	case "", "native":
		nt, err := nativetorrent.New(nativetorrent.Config{
			DataDir:     current.DownloadRoot,
			SessionDir:  current.TorrentSessionDir,
			PeerPort:    current.TorrentPeerPort,
			Readahead:   current.ReadAheadBytes,
			StartWindow: current.InitialBufferBytes,
		})
		if err != nil {
			return nil, fmt.Errorf("native torrent engine: %w", err)
		}
		engine, engineCloser, routePrefix = nt, nt, "native:"
	case "qbittorrent":
		engine = qbittorrent.New(func() (string, string, string) {
			v := settings.Get()
			return v.QBittorrentURL, v.QBittorrentUsername, v.QBittorrentPassword
		})
	default:
		return nil, fmt.Errorf("unknown download engine %q", current.DownloadEngine)
	}
	service := application.NewService(fl, engine, repo, settings, subtitles.NewSubDL(settings))
	service.SetMetadataProvider(tmdb.New(func() string { return settings.Get().TMDBAPIKey }))
	service.SetMediaProbe(mediaprobe.New(settings))
	service.SetEngineRoutePrefix(routePrefix)
	service.StartScheduler()
	handler := httpapi.New(service, settings, log, Version)
	server := &http.Server{Addr: current.ListenAddress, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	return &App{Server: server, Settings: settings, Repository: repo, Engine: engineCloser, ListenAddress: current.ListenAddress}, nil
}
func (a *App) ListenAndServe() error { return a.Server.ListenAndServe() }
func (a *App) Close() {
	if a.Engine != nil {
		_ = a.Engine.Close()
	}
	_ = a.Repository.Close()
}
