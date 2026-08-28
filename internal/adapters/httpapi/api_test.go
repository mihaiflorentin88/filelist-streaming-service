package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

func TestBrowserTranscodeRouteIsRemoved(t *testing.T) {
	dir := t.TempDir()
	b, err := json.Marshal(map[string]any{
		"databasePath": filepath.Join(dir, "test.db"),
		"downloadRoot": filepath.Join(dir, "downloads"),
		"trustedCidrs": []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "192.0.2.0/24"},
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EnvironmentPrefix+"SETTINGS_PATH", path)
	store, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	handler := New(nil, store, slog.New(slog.NewTextHandler(io.Discard, nil)), "test")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/streams/abc/browser", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/v1/streams/abc/browser status = %d, want 404", rec.Code)
	}
}

func TestDownloadDTOExposesOnlyProgressiveStream(t *testing.T) {
	b, err := json.Marshal(downloadDTO(domain.Download{ID: "abc", State: "downloading"}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	if strings.Contains(text, "browserStreamUrl") {
		t.Fatal("download DTO still advertises the removed browser compatibility stream")
	}
	if !strings.Contains(text, `"streamUrl":"/api/v1/streams/abc"`) {
		t.Fatal("download DTO lost the progressive playback stream URL")
	}
}

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
