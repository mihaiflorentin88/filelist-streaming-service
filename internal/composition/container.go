package composition

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/filelist"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/httpapi"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/mediaprobe"
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
	qb := qbittorrent.New(func() (string, string, string) {
		v := settings.Get()
		return v.QBittorrentURL, v.QBittorrentUsername, v.QBittorrentPassword
	})
	service := application.NewService(fl, qb, repo, settings, subtitles.NewSubDL(settings))
	service.SetMetadataProvider(tmdb.New(func() string { return settings.Get().TMDBAPIKey }))
	service.SetMediaProbe(mediaprobe.New(settings))
	service.StartScheduler()
	handler := httpapi.New(service, settings, log, Version)
	server := &http.Server{Addr: current.ListenAddress, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	return &App{Server: server, Settings: settings, Repository: repo, ListenAddress: current.ListenAddress}, nil
}
func (a *App) ListenAndServe() error { return a.Server.ListenAndServe() }
func (a *App) Close()                { _ = a.Repository.Close() }
