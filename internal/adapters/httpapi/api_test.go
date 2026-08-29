package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/application"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

func TestBrowserTranscodeRouteIsRegistered(t *testing.T) {
	handler := newStreamHTTPTest(t, &streamEngine{status: domain.DownloadStatus{
		State: "downloading", Progress: 0.05, Sequential: true, FirstLastPriority: true,
		TempPathEnabled: true, TempPath: t.TempDir(), SavePath: t.TempDir(), PieceSize: 1 << 20,
	}}, domain.Download{
		ID: "source", ReleaseID: "release", EngineID: "qb:abc", FileIndex: 0,
		FilePath: "movie.mkv", State: "downloading", Progress: 0.05, SizeBytes: 200 << 20,
	})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/streams/unknown/browser", nil))
	// An unknown source is refused by the media-info service (503, retryable),
	// not by routing (404): the compatibility route exists.
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /api/v1/streams/unknown/browser status = %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("compatibility route lost the Retry-After hint for in-flight sources")
	}
}

func TestDownloadDTOExposesCompatibilityStream(t *testing.T) {
	b, err := json.Marshal(downloadDTO(domain.Download{ID: "abc", State: "downloading"}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	if !strings.Contains(text, `"browserStreamUrl":"/api/v1/streams/abc/browser"`) {
		t.Fatal("download DTO lost the browser compatibility stream URL")
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

// — Acquire/GetDownload error mapping: a removed source is permanent (404),
// anything the server can transiently fail to resolve (database restart, locked
// database, torrent engine hiccup) is retryable (503 + Retry-After). Clients use
// the split to stop hammering on 404 and keep best-effort persistence otherwise.

type stubRepo struct {
	application.Repository
	downloadErr error
}

func (r stubRepo) GetDownload(context.Context, string) (domain.Download, error) {
	return domain.Download{}, r.downloadErr
}

func newStubHandler(t *testing.T, downloadErr error) http.Handler {
	t.Helper()
	dir := t.TempDir()
	b, err := json.Marshal(map[string]any{
		"databasePath": filepath.Join(dir, "test.db"),
		"downloadRoot": filepath.Join(dir, "downloads"),
		"trustedCidrs": []string{"127.0.0.0/8", "::1/128", "192.0.2.0/24"},
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
	service := application.NewService(nil, nil, stubRepo{Repository: nil, downloadErr: downloadErr}, store)
	return New(service, store, slog.New(slog.NewTextHandler(io.Discard, nil)), "test")
}

func TestStreamAcquireMissingSourceIs404(t *testing.T) {
	handler := newStubHandler(t, sql.ErrNoRows)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/streams/abc", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/v1/streams/abc status = %d, want 404", rec.Code)
	}
}

func TestStreamAcquireTransientErrorIs503(t *testing.T) {
	handler := newStubHandler(t, fmt.Errorf("get download: %w", errors.New("database is locked")))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/streams/abc", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /api/v1/streams/abc status = %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("transient acquire error lost the Retry-After hint")
	}
	var problem struct {
		Status int    `json:"status"`
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if problem.Status != http.StatusServiceUnavailable || !strings.Contains(problem.Detail, "database is locked") {
		t.Fatalf("problem body = %s, want 503 with the original detail", rec.Body.String())
	}
}

func TestPlaybackUpdateMissingSourceIs404(t *testing.T) {
	handler := newStubHandler(t, sql.ErrNoRows)
	rec := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/playback/abc", strings.NewReader(`{"positionMs":1000,"durationMs":5000}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("PUT /api/v1/playback/abc status = %d, want 404", rec.Code)
	}
}

func TestPlaybackUpdateTransientErrorIs503(t *testing.T) {
	handler := newStubHandler(t, fmt.Errorf("get download: %w", errors.New("database is locked")))
	rec := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/playback/abc", strings.NewReader(`{"positionMs":1000,"durationMs":5000}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("PUT /api/v1/playback/abc status = %d, want 503", rec.Code)
	}
}

func TestPlaybackUpdateNegativeInputIs400(t *testing.T) {
	handler := newStubHandler(t, nil)
	rec := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/playback/abc", strings.NewReader(`{"positionMs":-1,"durationMs":5000}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("PUT /api/v1/playback/abc status = %d, want 400", rec.Code)
	}
}

// — Allocation (GB) and free-space reserve (GB) settings round-trip through the
// settings API; invalid values fail with the standard validation problem.

func getSettingsBody(t *testing.T, handler http.Handler) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/settings status = %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func putSettingsBody(t *testing.T, handler http.Handler, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	for key := range body {
		if strings.HasSuffix(key, "Configured") || key == "settingsPath" {
			delete(body, key)
		}
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(string(b)))
	request.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, request)
	return rec
}

func TestSettingsRoundTripsAllocationAndReserve(t *testing.T) {
	handler := newStubHandler(t, nil)
	current := getSettingsBody(t, handler)
	current["allocationGb"] = 0.5
	current["reserveGb"] = 8.0
	if rec := putSettingsBody(t, handler, current); rec.Code != http.StatusOK {
		t.Fatalf("PUT /api/v1/settings status = %d, body = %s", rec.Code, rec.Body.String())
	}
	saved := getSettingsBody(t, handler)
	if saved["allocationGb"] != 0.5 || saved["reserveGb"] != 8.0 {
		t.Fatalf("GET lost the persisted allocation/reserve: %v/%v", saved["allocationGb"], saved["reserveGb"])
	}

	current = getSettingsBody(t, handler)
	current["allocationGb"] = -1
	rec := putSettingsBody(t, handler, current)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("negative allocation status = %d, want 400", rec.Code)
	}
	var problemBody struct {
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &problemBody); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(problemBody.Detail, "allocationGb") {
		t.Fatalf("validation problem did not name the field: %s", problemBody.Detail)
	}

	request := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(`{"allocationGb":NaN}`))
	request.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("NaN allocation status = %d, want 400", rec.Code)
	}

	current = getSettingsBody(t, handler)
	current["allocationGb"] = 0
	current["reserveGb"] = 0
	if rec := putSettingsBody(t, handler, current); rec.Code != http.StatusOK {
		t.Fatalf("zero (disabled) values status = %d, body = %s", rec.Code, rec.Body.String())
	}
	saved = getSettingsBody(t, handler)
	if saved["allocationGb"] != float64(0) || saved["reserveGb"] != float64(0) {
		t.Fatalf("disabled values did not persist: %v/%v", saved["allocationGb"], saved["reserveGb"])
	}
}

func TestSettingsSchemaListsRetentionFields(t *testing.T) {
	handler := newStubHandler(t, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/settings/schema", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/settings/schema status = %d", rec.Code)
	}
	var page struct {
		Items []struct {
			Key       string `json:"key"`
			Help      string `json:"help"`
			Sensitive bool   `json:"sensitive"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	descriptors := map[string]struct {
		Help      string
		Sensitive bool
	}{}
	for _, item := range page.Items {
		descriptors[item.Key] = struct {
			Help      string
			Sensitive bool
		}{item.Help, item.Sensitive}
	}
	for key, phrase := range map[string]string{
		"allocationGb": "0 disables retention",
		"reserveGb":    "0 disables the reserve check",
	} {
		descriptor, ok := descriptors[key]
		if !ok {
			t.Fatalf("settings schema lost %s", key)
		}
		if !strings.Contains(descriptor.Help, phrase) {
			t.Errorf("%s help = %q, want it to mention %q", key, descriptor.Help, phrase)
		}
		if descriptor.Sensitive {
			t.Errorf("%s must not be sensitive", key)
		}
	}
}
