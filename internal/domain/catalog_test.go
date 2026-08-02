package domain

import "testing"

func TestParseReleaseFixtures(t *testing.T) {
	tests := []struct {
		name, title string
		kind        MediaKind
		season      int
		episode     int
		resolution  string
		year        int
	}{
		{"One.Piece.S23E16.1080p.WEB-DL.AAC2.0.x264-SubsPlease", "One Piece", MediaSeries, 23, 16, "1080p", 0},
		{"Bleach.S17E42.SON.OF.DARKNESS.2160p.WEB-DL.DDP5.1.H.265", "Bleach", MediaSeries, 17, 42, "2160p", 0},
		{"Redakai.S02.1080p.WEB-DL.AAC2.0.H.264", "Redakai", MediaSeries, 2, 0, "1080p", 0},
		{"The.New.Fred.and.Barney.Show.S01-S02.1080p.WEB-DL", "The New Fred and Barney Show", MediaSeries, 1, 0, "1080p", 0},
		{"Severance.2022.1080p.BluRay.x265", "Severance", MediaMovie, 0, 0, "1080p", 2022},
		{"Shogun.1x02.Servants.of.Two.Masters.720p.HDTV", "Shogun", MediaSeries, 1, 2, "720p", 0},
		{"[Shinobi] Naruto Shippuden - Sezonul 01 [480p]", "Naruto Shippuden", MediaSeries, 1, 0, "480p", 0},
		{"Naruto Shippuden - Season 12 [SD]", "Naruto Shippuden", MediaSeries, 12, 0, "", 0},
	}
	for _, tt := range tests {
		p := ParseRelease(TorrentRelease{Name: tt.name})
		if p.Title != tt.title || p.Kind != tt.kind || p.SeasonStart != tt.season || p.EpisodeStart != tt.episode || p.Resolution != tt.resolution || p.Year != tt.year {
			t.Errorf("ParseRelease(%q) = %#v", tt.name, p)
		}
	}
}

func TestCatalogTitleIDPrefersIMDb(t *testing.T) {
	a := TorrentRelease{Name: "Film.2020.1080p", IMDbID: "tt123"}
	b := TorrentRelease{Name: "Completely.Different.2160p", IMDbID: "tt123"}
	if CatalogTitleID(a, ParseRelease(a)) != CatalogTitleID(b, ParseRelease(b)) {
		t.Fatal("same IMDb media should have the same canonical id")
	}
}
