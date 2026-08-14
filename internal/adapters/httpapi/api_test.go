package httpapi

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

func TestParseRange(t *testing.T) {
	tests := []struct {
		header      string
		start, end  int64
		partial, ok bool
	}{{"", 0, 99, false, true}, {"bytes=0-9", 0, 9, true, true}, {"bytes=90-", 90, 99, true, true}, {"bytes=-10", 90, 99, true, true}, {"bytes=0-1,4-5", 0, 0, true, false}, {"bytes=100-", 0, 0, true, false}}
	for _, tt := range tests {
		s, e, p, ok := parseRange(tt.header, 100)
		if s != tt.start || e != tt.end || p != tt.partial || ok != tt.ok {
			t.Errorf("%q got %d,%d,%v,%v", tt.header, s, e, p, ok)
		}
	}
}

func TestBrowserStreamArgsCopiesVideoAndSelectsOriginalAudio(t *testing.T) {
	info := domain.MediaInfo{DurationMS: 3_594_842, AudioTracks: []domain.MediaAudioTrack{
		{Index: 1, Language: "eng", Channels: 6, Default: true},
		{Index: 3, Language: "ron", Channels: 2},
	}}
	args, selected, err := browserStreamArgs("http://127.0.0.1/media", info, "3", "120000")
	if err != nil {
		t.Fatal(err)
	}
	if selected.Index != 3 {
		t.Fatalf("selected stream = %d", selected.Index)
	}
	wantPairs := [][]string{{"-ss", "120.000"}, {"-map", "0:3"}, {"-c:v", "copy"}, {"-c:a", "aac"}, {"-ac", "2"}}
	for _, pair := range wantPairs {
		found := false
		for i := 0; i+1 < len(args); i++ {
			if slices.Equal(args[i:i+2], pair) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("missing %v in %v", pair, args)
		}
	}
	for i := range args {
		if strings.HasPrefix(args[i], "-c:v") && args[i] != "-c:v" {
			t.Fatalf("unexpected video codec argument %q", args[i])
		}
	}
}

func TestBrowserStreamArgsRejectsInvalidTrackAndOffset(t *testing.T) {
	info := domain.MediaInfo{DurationMS: 10_000, AudioTracks: []domain.MediaAudioTrack{{Index: 1, Language: "eng"}}}
	if _, _, err := browserStreamArgs("input", info, "2", "0"); err == nil {
		t.Fatal("expected invalid audio stream error")
	}
	if _, _, err := browserStreamArgs("input", info, "1", "10000"); err == nil {
		t.Fatal("expected invalid offset error")
	}
}

func TestSettingsResponseRedactsSecrets(t *testing.T) {
	v := config.Defaults()
	v.FileListPasskey = "filelist-secret"
	v.QBittorrentPassword = "qb-secret"
	v.TMDBAPIKey = "tmdb-secret"
	b, err := json.Marshal(redactedSettings(v, "data/settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for _, secret := range []string{"filelist-secret", "qb-secret", "tmdb-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("response leaked %s", secret)
		}
	}
	if !strings.Contains(text, `"fileListPasskeyConfigured":true`) || !strings.Contains(text, `"qbittorrentPasswordConfigured":true`) {
		t.Fatal("configured indicators missing")
	}
}

func TestContentTypeUsesBrowserMediaTypes(t *testing.T) {
	for path, want := range map[string]string{
		"movie.mkv":  "video/matroska",
		"movie.mp4":  "video/mp4",
		"movie.webm": "video/webm",
	} {
		if got := contentType(path); got != want {
			t.Errorf("contentType(%q) = %q, want %q", path, got, want)
		}
	}
}
