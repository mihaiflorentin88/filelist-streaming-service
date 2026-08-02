package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

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
