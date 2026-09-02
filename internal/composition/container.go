package composition

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
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
)

var Version = "dev"

type App struct {
	Server        *http.Server
	Settings      *config.Store
	Repository    *sqlite.Repository
	Engine        io.Closer
	ListenAddress string
}

func New(log *slog.Logger) (*App, error) {
	settings, err := config.Load()
	if err != nil {
		return nil, err
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
