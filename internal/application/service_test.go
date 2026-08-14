package application

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

type pieceEngine struct{ TorrentEngine }

func (pieceEngine) Pieces(context.Context, string) (domain.PieceMap, error) {
	return domain.PieceMap{States: []int{2, 0}, PieceSize: 4}, nil
}

func TestSafeJoinRejectsTraversal(t *testing.T) {
	if _, err := safeJoin("/srv/downloads", "../../etc/passwd"); err == nil {
		t.Fatal("expected traversal rejection")
	}
	p, err := safeJoin("/srv/downloads", "Show/episode.mkv")
	if err != nil || p != "/srv/downloads/Show/episode.mkv" {
		t.Fatalf("unexpected %q %v", p, err)
	}
}

func TestSafeQBPathUsesContainedSavePath(t *testing.T) {
	p, err := safeQBPath("/srv/downloads", "/srv/downloads/movies", "Movie/video.mkv")
	if err != nil || p != "/srv/downloads/movies/Movie/video.mkv" {
		t.Fatalf("unexpected %q %v", p, err)
	}
	if _, err := safeQBPath("/srv/downloads", "/var/tmp", "video.mkv"); err == nil {
		t.Fatal("expected an outside qBittorrent save path to be rejected")
	}
}

func TestSafeQBContentPathHandlesTempAndFinalLocations(t *testing.T) {
	tests := []struct {
		content string
		name    string
		want    string
	}{
		{"/srv/downloads/.incomplete/Movie", "Movie/video.mkv", "/srv/downloads/.incomplete/Movie/video.mkv"},
		{"/srv/downloads/.incomplete/video.mkv", "video.mkv", "/srv/downloads/.incomplete/video.mkv"},
		{"/srv/downloads/Movie", "Movie/video.mkv", "/srv/downloads/Movie/video.mkv"},
	}
	for _, test := range tests {
		got, err := safeQBContentPath("/srv/downloads", domain.DownloadStatus{ContentPath: test.content}, test.name)
		if err != nil || got != test.want {
			t.Fatalf("safeQBContentPath(%q, %q) = %q, %v", test.content, test.name, got, err)
		}
	}
	if _, err := safeQBContentPath("/srv/downloads", domain.DownloadStatus{ContentPath: "/var/tmp/Movie"}, "Movie/video.mkv"); err == nil {
		t.Fatal("expected outside content path rejection")
	}
}

func TestSafeQBContentPathUsesConfiguredTemporaryPathWhileIncomplete(t *testing.T) {
	status := domain.DownloadStatus{
		Progress:        0.19,
		SavePath:        "/mnt/media/torrent",
		ContentPath:     "/mnt/media/torrent/movie.mkv",
		TempPathEnabled: true,
		TempPath:        "/mnt/media/torrent/.incomplete",
	}
	path, err := safeQBContentPath("/mnt/media/torrent", status, "movie.mkv")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/mnt/media/torrent/.incomplete/movie.mkv" {
		t.Fatalf("unexpected temporary path %q", path)
	}
}

func TestSafeQBContentPathUsesFinalPathAtCompletion(t *testing.T) {
	status := domain.DownloadStatus{
		Progress:        1,
		SavePath:        "/mnt/media/torrent",
		ContentPath:     "/mnt/media/torrent/movie.mkv",
		TempPathEnabled: true,
		TempPath:        "/mnt/media/torrent/.incomplete",
	}
	path, err := safeQBContentPath("/mnt/media/torrent", status, "movie.mkv")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/mnt/media/torrent/movie.mkv" {
		t.Fatalf("unexpected completed path %q", path)
	}
}

func TestWaitRangeDoesNotRequireTorrentCompletion(t *testing.T) {
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(previous) }()
	settings, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{engine: pieceEngine{}, settings: settings}
	download := domain.Download{EngineID: "qb:abc", PieceSize: 4, Progress: 0.5}
	if err := service.WaitRange(t.Context(), download, 0, 4); err != nil {
		t.Fatalf("downloaded range in incomplete torrent should be immediately streamable: %v", err)
	}
}

func TestApplyDownloadStatusUsesSelectedFileMetrics(t *testing.T) {
	download := domain.Download{FileIndex: 2, SizeBytes: 40_474_209_647}
	status := domain.DownloadStatus{State: "downloading", Progress: 0.9, DownloadedBytes: 36_000_000_000, SpeedBytesPerSecond: 12_000_000}
	selected := domain.TorrentFile{Index: 2, SizeBytes: 5_075_031_232, Progress: 0.25, Offset: 10_000_000_000}
	applyDownloadStatus(&download, status, &selected)
	if download.SizeBytes != selected.SizeBytes || download.Progress != 0.25 || download.DownloadedBytes != 1_268_757_808 {
		t.Fatalf("download did not use selected-file metrics: %+v", download)
	}
	if download.FileOffset != selected.Offset || download.SpeedBytesPerSecond != status.SpeedBytesPerSecond {
		t.Fatalf("download lost torrent status fields: %+v", download)
	}
}

func TestCompletedLocalFileRequiresSelectedFileCompletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "episode.mkv")
	if err := os.WriteFile(path, make([]byte, 16), 0o640); err != nil {
		t.Fatal(err)
	}
	download := domain.Download{AbsolutePath: path, SizeBytes: 16, State: "stalledUP", Progress: 0}
	if completedLocalFile(download) {
		t.Fatal("torrent upload state must not mark a newly selected incomplete file as local")
	}
	download.Progress = 1
	if !completedLocalFile(download) {
		t.Fatal("a complete selected file at its final path should use local playback")
	}
}

func TestDedupeManagedDownloadsKeepsDistinctSeasonEpisodes(t *testing.T) {
	items := []domain.Download{
		{ID: "new", EngineID: "qb:hash", FileIndex: 2, FilePath: "S01E03.mkv"},
		{ID: "legacy-duplicate", EngineID: "qb:hash", FileIndex: 2, FilePath: "renamed/S01E03.mkv"},
		{ID: "next-episode", EngineID: "qb:hash", FileIndex: 3, FilePath: "S01E04.mkv"},
	}
	got := dedupeManagedDownloads(items)
	if len(got) != 2 || got[0].ID != "new" || got[1].ID != "next-episode" {
		t.Fatalf("unexpected download reconciliation: %#v", got)
	}
}
