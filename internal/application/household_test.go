package application

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/sqlite"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

type removeEngine struct {
	TorrentEngine
	deleteFiles bool
	err         error
}

func (e *removeEngine) Remove(_ context.Context, _ string, deleteFiles bool) error {
	e.deleteFiles = deleteFiles
	return e.err
}

func TestHouseholdStateAndRemovalLifecycle(t *testing.T) {
	dir := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(previous) }()
	settings, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	repo, err := sqlite.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	now := time.Now().UTC()
	ctx := context.Background()
	release := domain.TorrentRelease{ID: "release", Name: "Movie", Category: "Movies"}
	if err := repo.UpsertReleases(ctx, []domain.TorrentRelease{release}); err != nil {
		t.Fatal(err)
	}
	download := domain.Download{ID: "source", ReleaseID: release.ID, EngineID: "qb:hash", FileIndex: 2, FilePath: "movie.mkv", AbsolutePath: "/downloads/movie.mkv", State: "complete", CreatedAt: now, UpdatedAt: now}
	if err := repo.SaveDownload(ctx, download); err != nil {
		t.Fatal(err)
	}
	engine := &removeEngine{}
	service := NewService(nil, engine, repo, settings)
	state, err := service.UpdatePlayback(ctx, download.ID, 899, 1000)
	if err != nil || state.Watched {
		t.Fatalf("89.9%% must not be watched: %#v %v", state, err)
	}
	state, err = service.UpdatePlayback(ctx, download.ID, 900, 1000)
	if err != nil || !state.Watched {
		t.Fatalf("90%% must be watched: %#v %v", state, err)
	}
	if err := service.SetFavorite(ctx, release.ID, true); err != nil {
		t.Fatal(err)
	}
	household, err := service.HouseholdState(ctx)
	if err != nil || len(household.Favorites) != 1 || len(household.Watched) != 1 || len(household.Recent) != 1 {
		t.Fatalf("bad household state %#v %v", household, err)
	}
	if err := service.Manage(ctx, download.ID, "remove", true); err != nil {
		t.Fatal(err)
	}
	if !engine.deleteFiles {
		t.Fatal("deleteFiles was not forwarded")
	}
	if _, err := repo.GetDownload(ctx, download.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("managed row survived removal: %v", err)
	}
	if _, err := repo.GetPlayback(ctx, householdProfile, download.ID); err != nil {
		t.Fatalf("history did not survive removal: %v", err)
	}
	missing := download
	missing.ID = "missing"
	missing.Leased = true
	if err := repo.SaveDownload(ctx, missing); err != nil {
		t.Fatal(err)
	}
	if err := service.Manage(ctx, missing.ID, "remove", false); err == nil {
		t.Fatal("leased download removal should be rejected")
	}
	missing.Leased = false
	if err := repo.SaveDownload(ctx, missing); err != nil {
		t.Fatal(err)
	}
	engine.err = domain.ErrTorrentNotFound
	if err := service.Manage(ctx, missing.ID, "remove", false); err != nil {
		t.Fatalf("already-absent torrent should be forgotten: %v", err)
	}
	if _, err := repo.GetDownload(ctx, missing.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("already-absent torrent record survived: %v", err)
	}
}
