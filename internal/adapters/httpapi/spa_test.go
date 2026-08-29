package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// — App shell: the web app owns client-side routes (/library/downloads,
// /search?q=). Any GET outside /api/ that matches no embedded asset serves
// index.html so deep paths survive refreshes and shared links; real assets
// keep coming from the file server and API routing is untouched.

func newShellHandler(t *testing.T) http.Handler {
	t.Helper()
	original := webFS
	webFS = fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<!doctype html><html><body><div id=\"app\"></div></body></html>\n")},
		"assets/app.js": &fstest.MapFile{Data: []byte("export {}\n")},
	}
	t.Cleanup(func() { webFS = original })
	return newStubHandler(t, nil)
}

func TestAppShellServesClientRoutes(t *testing.T) {
	handler := newShellHandler(t)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/library/downloads", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /library/downloads status = %d, want 200", rec.Code)
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("GET /library/downloads content type = %q, want text/html", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), `id="app"`) {
		t.Fatalf("GET /library/downloads body = %q, want the app shell", rec.Body.String())
	}
}

func TestAppShellServesRoot(t *testing.T) {
	handler := newShellHandler(t)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `id="app"`) {
		t.Fatalf("GET / status = %d body = %q, want the app shell", rec.Code, rec.Body.String())
	}
}

func TestAppShellStillServesAssets(t *testing.T) {
	handler := newShellHandler(t)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /assets/app.js status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "export {}\n" {
		t.Fatalf("GET /assets/app.js body = %q, want the asset bytes", got)
	}
}

func TestAppShellKeepsAPIRouting(t *testing.T) {
	handler := newShellHandler(t)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/unknown", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/v1/unknown status = %d, want 404", rec.Code)
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/system/info status = %d, want 200", rec.Code)
	}
}
