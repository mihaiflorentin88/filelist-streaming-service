package application

import (
	"testing"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
)

func TestGroupCatalogBuildsSeriesHierarchySummary(t *testing.T) {
	now := time.Now().UTC()
	one := domain.TorrentRelease{ID: "1", Name: "Show.S01E01.1080p.WEB-DL", IMDbID: "tt42", Category: "TV-Series HD", Seeders: 8, SizeBytes: 100, UploadedAt: &now}
	two := domain.TorrentRelease{ID: "2", Name: "Show.S01E02.2160p.WEB-DL", IMDbID: "tt42", Category: "TV-Series 4K", Seeders: 12, SizeBytes: 200, UploadedAt: &now}
	items := []domain.CatalogSource{{Release: one, Parsed: domain.ParseRelease(one)}, {Release: two, Parsed: domain.ParseRelease(two)}}
	titles := groupCatalog(items, false)
	if len(titles) != 1 || titles[0].EpisodeCount != 2 || titles[0].SeasonCount != 1 || titles[0].SourceCount != 2 || titles[0].BestSeeders != 12 || titles[0].LargestSizeBytes != 200 {
		t.Fatalf("unexpected grouped title %#v", titles)
	}
}

func TestFilterCatalogSources(t *testing.T) {
	release := domain.TorrentRelease{Name: "Film.2024.2160p.HDR.WEB-DL", Category: "Movies 4K", Seeders: 7, Freeleech: true}
	item := domain.CatalogSource{Release: release, Parsed: domain.ParseRelease(release)}
	yes := true
	if got := filterCatalogSources([]domain.CatalogSource{item}, domain.CatalogQuery{Kind: domain.MediaMovie, Resolution: "2160p", MinSeeders: 5, Freeleech: &yes}); len(got) != 1 {
		t.Fatal("matching source was filtered out")
	}
	if got := filterCatalogSources([]domain.CatalogSource{item}, domain.CatalogQuery{MinSeeders: 8}); len(got) != 0 {
		t.Fatal("minimum seeder filter was ignored")
	}
	game := domain.TorrentRelease{Name: "Naruto game", Category: "Games PC", Seeders: 20}
	if got := filterCatalogSources([]domain.CatalogSource{{Release: game, Parsed: domain.ParseRelease(game)}}, domain.CatalogQuery{Search: "naruto"}); len(got) != 0 {
		t.Fatal("default-blacklisted category leaked into media discovery")
	}
}

func TestSeasonPackEpisodeSourceUsesTorrentFileIndex(t *testing.T) {
	baseRelease := domain.TorrentRelease{ID: "pack", Name: "Show.S02.1080p.WEB-DL", Category: "TV-Series HD", Seeders: 4}
	base := domain.CatalogSource{Release: baseRelease, Parsed: domain.ParseRelease(baseRelease)}
	source, ok := episodeSource(base, domain.TorrentFile{Index: 7, Path: "Show.S02E03.1080p.mkv", SizeBytes: 1234, Playable: true})
	if !ok || source.FileIndex == nil || *source.FileIndex != 7 || source.Parsed.SeasonStart != 2 || source.Parsed.EpisodeStart != 3 || source.FileSizeBytes != 1234 {
		t.Fatalf("season pack file was not expanded correctly: %#v", source)
	}
}

func TestReadBencodedTorrentFiles(t *testing.T) {
	data := []byte("d4:infod5:filesld6:lengthi12e4:pathl15:Show.S01E01.mkveed6:lengthi34e4:pathl15:Show.S01E02.mkveeeee")
	root, _, err := readBNode(data, 0)
	if err != nil {
		t.Fatal(err)
	}
	files := root.dict["info"].dict["files"].list
	if len(files) != 2 || string(files[1].dict["path"].list[0].value) != "Show.S01E02.mkv" {
		t.Fatalf("unexpected files: %#v", files)
	}
}
