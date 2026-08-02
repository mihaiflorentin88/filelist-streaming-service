package application

import (
	"context"
	"os"
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
