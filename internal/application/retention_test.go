package application

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/sqlite"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

type retentionEngine struct {
	TorrentEngine
	mu           sync.Mutex
	status       map[string]domain.DownloadStatus
	removed      []string
	removedFiles []bool
	freed        int64
}

func (e *retentionEngine) Status(_ context.Context, hash string) (domain.DownloadStatus, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	st, ok := e.status[hash]
	if !ok {
		return domain.DownloadStatus{}, domain.ErrTorrentNotFound
	}
	return st, nil
}

func (e *retentionEngine) Remove(_ context.Context, hash string, deleteFiles bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if st, ok := e.status[hash]; ok {
		e.freed += st.TotalBytes
		delete(e.status, hash)
	}
	e.removed = append(e.removed, hash)
	e.removedFiles = append(e.removedFiles, deleteFiles)
	return nil
}

func (e *retentionEngine) freedSnapshot() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.freed
}

func retentionSettings(t *testing.T, store *config.Store, allocationGB, reserveGB float64) {
	t.Helper()
	value := store.Get()
	value.AllocationGB = allocationGB
	value.ReserveGB = reserveGB
	if err := store.Save(value); err != nil {
		t.Fatal(err)
	}
}

func seedRetentionDownload(t *testing.T, repo *sqlite.Repository, id, releaseID, engineID string, updated time.Time, leased bool, progress float64) {
	t.Helper()
	row := domain.Download{ID: id, ReleaseID: releaseID, EngineID: engineID, FilePath: id + ".mkv", State: "pausedUP", Progress: progress, Leased: leased, CreatedAt: updated, UpdatedAt: updated}
	if err := repo.SaveDownload(context.Background(), row); err != nil {
		t.Fatal(err)
	}
}

func seedRetentionRelease(t *testing.T, repo *sqlite.Repository, releaseID, name string) {
	t.Helper()
	if err := repo.UpsertReleases(context.Background(), []domain.TorrentRelease{{ID: releaseID, Name: name, Category: "Series"}}); err != nil {
		t.Fatal(err)
	}
}

func retentionEvents(t *testing.T, service *Service) []map[string]any {
	t.Helper()
	events, err := service.Events(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	payloads := []map[string]any{}
	for _, event := range events {
		if event.Kind != "downloads.evicted" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(event.Payload), &payload); err != nil {
			t.Fatalf("eviction event payload is not JSON: %v", err)
		}
		payloads = append(payloads, payload)
	}
	if len(payloads) == 0 {
		t.Fatalf("no downloads.evicted event in journal: %d events", len(events))
	}
	return payloads
}

func evictionReleases(t *testing.T, payload map[string]any) []string {
	t.Helper()
	raw, _ := payload["releases"].([]any)
	names := make([]string, 0, len(raw))
	for _, item := range raw {
		name, _ := item.(string)
		names = append(names, name)
	}
	return names
}

func TestRetentionEvictsOldestCompletedUntilWithinCap(t *testing.T) {
	repo, settings := retryHarness(t)
	retentionSettings(t, settings, 1, 0)
	seedRetentionRelease(t, repo, "first-release", "First.S01.1080p.WEB-DL")
	seedRetentionRelease(t, repo, "second-release", "Second.S01.1080p.WEB-DL")
	engine := &retentionEngine{status: map[string]domain.DownloadStatus{
		"old":    {Hash: "old", State: "pausedUP", Progress: 1, TotalBytes: 600 << 20},
		"middle": {Hash: "middle", State: "pausedUP", Progress: 1, TotalBytes: 600 << 20},
		"newest": {Hash: "newest", State: "pausedUP", Progress: 1, TotalBytes: 600 << 20},
	}}
	base := time.Now().UTC().Add(-3 * time.Hour)
	seedRetentionDownload(t, repo, "first", "first-release", "qb:old", base, false, 1)
	seedRetentionDownload(t, repo, "second", "second-release", "qb:middle", base.Add(time.Hour), false, 1)
	seedRetentionDownload(t, repo, "third", "third-release", "qb:newest", base.Add(2*time.Hour), false, 1)
	service := NewService(openCatalog{}, engine, repo, settings)

	job, err := service.RunRetention()
	if err != nil {
		t.Fatal(err)
	}
	if job.Kind != "retention" || job.DedupeKey != "retention" || job.State != "completed" {
		t.Fatalf("retention job did not complete: %#v", job)
	}
	if len(engine.removed) != 2 || engine.removed[0] != "old" || engine.removed[1] != "middle" {
		t.Fatalf("eviction did not take oldest completed first: %v", engine.removed)
	}
	if slices.Contains(engine.removedFiles, false) {
		t.Fatal("eviction must delete files like the manual remove action")
	}
	for _, id := range []string{"first", "second"} {
		if _, err := repo.GetDownload(context.Background(), id); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("evicted row %s survived: %v", id, err)
		}
	}
	if _, err := repo.GetDownload(context.Background(), "third"); err != nil {
		t.Fatalf("uninvolved download was evicted: %v", err)
	}
	payload := retentionEvents(t, service)
	found := false
	for _, event := range payload {
		if event["reason"] == "cap" && slices.Contains(evictionReleases(t, event), "First.S01.1080p.WEB-DL") {
			found = true
			titles, _ := event["titles"].([]any)
			if len(titles) != 1 || titles[0] == "" {
				t.Fatalf("eviction event lacks a title: %v", event)
			}
		}
	}
	if !found {
		t.Fatalf("no cap eviction event naming the oldest release: %v", payload)
	}
}

func TestRetentionReserveBreachEvictsWhenCapSatisfied(t *testing.T) {
	repo, settings := retryHarness(t)
	retentionSettings(t, settings, 100, 1)
	engine := &retentionEngine{status: map[string]domain.DownloadStatus{
		"only": {Hash: "only", State: "pausedUP", Progress: 1, TotalBytes: 600 << 20},
	}}
	seedRetentionDownload(t, repo, "solo", "solo-release", "qb:only", time.Now().UTC().Add(-time.Hour), false, 1)
	service := NewService(openCatalog{}, engine, repo, settings)
	free := int64(512 << 20)
	service.freeSpace = func(string) (int64, error) { return free + engine.freedSnapshot(), nil }

	if _, err := service.RunRetention(); err != nil {
		t.Fatal(err)
	}
	if len(engine.removed) != 1 || engine.removed[0] != "only" {
		t.Fatalf("reserve breach did not evict the torrent: %v", engine.removed)
	}
	if _, err := repo.GetDownload(context.Background(), "solo"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("evicted row survived: %v", err)
	}
	payload := retentionEvents(t, service)
	if len(payload) != 1 || payload[0]["reason"] != "reserve" {
		t.Fatalf("eviction event reason = %v, want reserve", payload)
	}
	// Reserve is met now; a second pass must not evict anything further.
	if _, err := service.RunRetention(); err != nil {
		t.Fatal(err)
	}
	if len(engine.removed) != 1 {
		t.Fatalf("satisfied reserve evicted again: %v", engine.removed)
	}
}

func TestRetentionNeverEvictsIncompleteOrLeased(t *testing.T) {
	repo, settings := retryHarness(t)
	retentionSettings(t, settings, 1, 0)
	engine := &retentionEngine{status: map[string]domain.DownloadStatus{
		"incomplete": {Hash: "incomplete", State: "downloading", Progress: 0.5, TotalBytes: 600 << 20},
		"leased":     {Hash: "leased", State: "pausedUP", Progress: 1, TotalBytes: 600 << 20},
		"eligible":   {Hash: "eligible", State: "pausedUP", Progress: 1, TotalBytes: 600 << 20},
	}}
	base := time.Now().UTC().Add(-3 * time.Hour)
	seedRetentionDownload(t, repo, "watching", "watching-release", "qb:leased", base, true, 1)
	seedRetentionDownload(t, repo, "fetching", "fetching-release", "qb:incomplete", base.Add(time.Hour), false, 0.5)
	seedRetentionDownload(t, repo, "spare", "spare-release", "qb:eligible", base.Add(2*time.Hour), false, 1)
	service := NewService(openCatalog{}, engine, repo, settings)

	job, err := service.RunRetention()
	if err != nil {
		t.Fatal(err)
	}
	if job.State != "completed" {
		t.Fatalf("retention job state = %q, want completed", job.State)
	}
	if len(engine.removed) != 1 || engine.removed[0] != "eligible" {
		t.Fatalf("protected downloads were evicted: %v", engine.removed)
	}
	for _, id := range []string{"watching", "fetching"} {
		if _, err := repo.GetDownload(context.Background(), id); err != nil {
			t.Fatalf("protected row %s did not survive: %v", id, err)
		}
	}
}

func TestRetentionEvictsSeasonPackSiblingsTogether(t *testing.T) {
	repo, settings := retryHarness(t)
	retentionSettings(t, settings, 1, 0)
	seedRetentionRelease(t, repo, "pack-release", "Pack.S01.1080p.WEB-DL")
	engine := &retentionEngine{status: map[string]domain.DownloadStatus{
		"pack":  {Hash: "pack", State: "pausedUP", Progress: 1, TotalBytes: 800 << 20},
		"loner": {Hash: "loner", State: "pausedUP", Progress: 1, TotalBytes: 600 << 20},
	}}
	base := time.Now().UTC().Add(-2 * time.Hour)
	seedRetentionDownload(t, repo, "ep1", "pack-release", "qb:pack", base, false, 1)
	seedRetentionDownload(t, repo, "ep2", "pack-release", "qb:pack", base.Add(time.Second), false, 1)
	seedRetentionDownload(t, repo, "film", "film-release", "qb:loner", base.Add(time.Hour), false, 1)
	service := NewService(openCatalog{}, engine, repo, settings)

	if _, err := service.RunRetention(); err != nil {
		t.Fatal(err)
	}
	if len(engine.removed) != 1 || engine.removed[0] != "pack" {
		t.Fatalf("eviction picked the wrong torrent: %v", engine.removed)
	}
	for _, id := range []string{"ep1", "ep2"} {
		if _, err := repo.GetDownload(context.Background(), id); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("season-pack sibling %s survived the eviction: %v", id, err)
		}
	}
	if _, err := repo.GetDownload(context.Background(), "film"); err != nil {
		t.Fatalf("uninvolved download was evicted: %v", err)
	}
	payload := retentionEvents(t, service)
	if len(payload) != 1 {
		t.Fatalf("expected one eviction event, got %d", len(payload))
	}
	if releases := evictionReleases(t, payload[0]); len(releases) != 1 || releases[0] != "Pack.S01.1080p.WEB-DL" {
		t.Fatalf("eviction event names the wrong release: %v", payload[0])
	}
}

func TestRetentionZeroSettingsDisableChecks(t *testing.T) {
	repo, settings := retryHarness(t)
	retentionSettings(t, settings, 0, 0)
	engine := &retentionEngine{status: map[string]domain.DownloadStatus{
		"big": {Hash: "big", State: "pausedUP", Progress: 1, TotalBytes: 500 << 30},
	}}
	seedRetentionDownload(t, repo, "huge", "huge-release", "qb:big", time.Now().UTC().Add(-time.Hour), false, 1)
	service := NewService(openCatalog{}, engine, repo, settings)
	service.freeSpace = func(string) (int64, error) { return 0, nil }

	job, err := service.RunRetention()
	if err != nil {
		t.Fatal(err)
	}
	if job.State != "completed" || len(engine.removed) != 0 {
		t.Fatalf("zero-valued settings must disable both checks: state=%q removed=%v", job.State, engine.removed)
	}
	if _, err := repo.GetDownload(context.Background(), "huge"); err != nil {
		t.Fatalf("download was evicted despite disabled checks: %v", err)
	}
}
