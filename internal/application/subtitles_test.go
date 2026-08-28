package application

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/adapters/sqlite"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

func TestUnpackSubtitleAcceptsPlainTextMislabeledAsZip(t *testing.T) {
	data := []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n")
	got, format, err := unpackSubtitle(data, ".zip", "provider.zip", "Movie.mkv")
	if err != nil {
		t.Fatal(err)
	}
	if format != ".srt" || !strings.Contains(string(got), "Hello") {
		t.Fatalf("format=%q data=%q", format, got)
	}
}

func TestParseSubtitleSearchScope(t *testing.T) {
	tests := []struct {
		input string
		want  SubtitleSearchScope
		err   bool
	}{
		{input: "", want: SubtitleScopeAll},
		{input: " LOCAL ", want: SubtitleScopeLocal},
		{input: "remote", want: SubtitleScopeRemote},
		{input: "all", want: SubtitleScopeAll},
		{input: "provider", err: true},
	}
	for _, test := range tests {
		got, err := ParseSubtitleSearchScope(test.input)
		if (err != nil) != test.err {
			t.Fatalf("ParseSubtitleSearchScope(%q) error = %v", test.input, err)
		}
		if got != test.want {
			t.Fatalf("ParseSubtitleSearchScope(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

type subtitleEngineStub struct {
	TorrentEngine
	files []domain.TorrentFile
}

func (e *subtitleEngineStub) Files(context.Context, string) ([]domain.TorrentFile, error) {
	return e.files, nil
}

type subtitleProbeStub struct {
	MediaProbe
	tracks  []domain.MediaSubtitleTrack
	content string
}

func (p *subtitleProbeStub) ProbeSubtitles(context.Context, string) ([]domain.MediaSubtitleTrack, error) {
	return p.tracks, nil
}

func (p *subtitleProbeStub) ExtractSubtitle(_ context.Context, _ string, _ int, target string) error {
	return os.WriteFile(target, []byte(p.content), 0o600)
}

type subtitleProviderStub struct {
	SubtitleProvider
	items []domain.SubtitleCandidate
}

func (p *subtitleProviderStub) Name() string { return "subdl" }

func (p *subtitleProviderStub) Search(context.Context, SubtitleQuery) ([]domain.SubtitleCandidate, error) {
	return p.items, nil
}

func newSubtitleTestServiceWithRepo(t *testing.T, engine *subtitleEngineStub, probe *subtitleProbeStub, providers ...SubtitleProvider) (*Service, *sqlite.Repository) {
	t.Helper()
	dir := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	settings, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	repo, err := sqlite.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	ctx := context.Background()
	release := domain.TorrentRelease{ID: "release", Name: "Movie.2023.JAPANESE.1080p.WEB-DL"}
	if err := repo.UpsertReleases(ctx, []domain.TorrentRelease{release}); err != nil {
		t.Fatal(err)
	}
	media := filepath.Join(dir, "movie.mkv")
	if err := os.WriteFile(media, []byte("media"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	download := domain.Download{ID: "source", ReleaseID: release.ID, EngineID: "qb:abc", FileIndex: 0, FilePath: "movie.mkv", AbsolutePath: media, State: "complete", CreatedAt: now, UpdatedAt: now}
	if err := repo.SaveDownload(ctx, download); err != nil {
		t.Fatal(err)
	}
	service := NewService(nil, engine, repo, settings, providers...)
	service.SetMediaProbe(probe)
	return service, repo
}

func newSubtitleTestService(t *testing.T, engine *subtitleEngineStub, probe *subtitleProbeStub, providers ...SubtitleProvider) *Service {
	service, _ := newSubtitleTestServiceWithRepo(t, engine, probe, providers...)
	return service
}

func candidateByProvider(items []domain.SubtitleCandidate, provider string) domain.SubtitleCandidate {
	for _, item := range items {
		if item.Provider == provider {
			return item
		}
	}
	return domain.SubtitleCandidate{}
}

func TestSearchSubtitlesNormalizesLanguageFromEverySource(t *testing.T) {
	service := newSubtitleTestService(
		t,
		&subtitleEngineStub{files: []domain.TorrentFile{{Index: 7, Path: "Movie.jpn.srt"}}},
		&subtitleProbeStub{tracks: []domain.MediaSubtitleTrack{{Index: 3, Language: "jpn", Codec: "subrip"}}},
		&subtitleProviderStub{items: []domain.SubtitleCandidate{{ID: "p1", Language: "jpn", Title: "Movie.jpn.srt", Score: 10}}},
	)
	items, _, err := service.SearchSubtitles(context.Background(), "source", "ja", SubtitleScopeAll)
	if err != nil {
		t.Fatal(err)
	}
	contained := candidateByProvider(items, "contained")
	embedded := candidateByProvider(items, "embedded")
	provider := candidateByProvider(items, "subdl")
	if contained.ID != "7" || contained.Language != "ja" {
		t.Fatalf("contained candidate = %#v, want id 7 language ja", contained)
	}
	if embedded.ID != "3" || embedded.Language != "ja" {
		t.Fatalf("embedded candidate = %#v, want id 3 language ja", embedded)
	}
	if provider.ID != "p1" || provider.Language != "ja" {
		t.Fatalf("subdl candidate = %#v, want id p1 language ja", provider)
	}
}

func TestPrepareSubtitleEmbeddedAssetKeepsCandidateLanguage(t *testing.T) {
	probe := &subtitleProbeStub{
		tracks:  []domain.MediaSubtitleTrack{{Index: 3, Language: "jpn", Codec: "subrip"}},
		content: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n",
	}
	service := newSubtitleTestService(t, &subtitleEngineStub{}, probe)
	asset, err := service.PrepareSubtitle(context.Background(), "source", "embedded", "3", "vtt")
	if err != nil {
		t.Fatal(err)
	}
	if asset.Language != "ja" {
		t.Fatalf("prepared embedded asset language = %q, want the candidate's canonical language ja", asset.Language)
	}
	reused, err := service.PrepareSubtitle(context.Background(), "source", "embedded", "3", "vtt")
	if err != nil {
		t.Fatal(err)
	}
	if reused.Language != "ja" {
		t.Fatalf("persisted embedded asset language = %q, want ja to survive a restart", reused.Language)
	}
}

func TestSearchSubtitlesMarksPreparedProviderCandidatesCached(t *testing.T) {
	service, repo := newSubtitleTestServiceWithRepo(
		t,
		&subtitleEngineStub{},
		&subtitleProbeStub{},
		&subtitleProviderStub{items: []domain.SubtitleCandidate{{ID: "p1", Language: "jpn", Title: "Movie.jpn.srt", Score: 10}}},
	)
	ctx := context.Background()
	now := time.Now().UTC()
	if err := repo.SaveSubtitleAsset(ctx, domain.SubtitleAsset{ID: "asset", SourceID: "source", Provider: "subdl", CandidateID: "p1", Name: "Movie.jpn.srt", Language: "ja", Format: "vtt", MimeType: "text/vtt", Path: "/tmp/asset.vtt", CreatedAt: now, LastUsedAt: now}); err != nil {
		t.Fatal(err)
	}
	items, _, err := service.SearchSubtitles(ctx, "source", "ja", SubtitleScopeAll)
	if err != nil {
		t.Fatal(err)
	}
	provider := candidateByProvider(items, "subdl")
	if provider.ID != "p1" || !provider.Cached {
		t.Fatalf("subdl candidate = %#v, want cached=true once an asset is prepared", provider)
	}
}
