package gui

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// staticHandler is a stand-in for the embedded vite build.
func staticHandler(w http.ResponseWriter, r *http.Request) {
	_, _ = io.WriteString(w, "static:"+r.URL.Path)
}

func body(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(b)
}

func startBackend(t *testing.T, hits *atomic.Int32, sawHost *atomic.Value) *httptest.Server {
	t.Helper()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if sawHost != nil {
			sawHost.Store(r.Host)
		}
		_, _ = io.WriteString(w, "backend:"+r.URL.Path+"?"+r.URL.RawQuery)
	}))
	t.Cleanup(backend.Close)
	return backend
}

// TestServerProxyForwardsAPIPaths checks the /api/ branch end to end: the
// request reaches the looked-up address with path and query intact, and the
// backend's response passes back through.
func TestServerProxyForwardsAPIPaths(t *testing.T) {
	var hits atomic.Int32
	backend := startBackend(t, &hits, nil)
	proxy := newServerProxy(http.HandlerFunc(staticHandler), func() (string, bool) {
		return backend.Listener.Addr().String(), true
	}, testLogger())

	resp, err := http.Post(proxyURL(t, proxy), "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got, want := body(t, resp), "backend:/api/v1/jobs?page=2"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if hits.Load() != 1 {
		t.Fatalf("backend hits = %d, want 1", hits.Load())
	}
}

func proxyURL(t *testing.T, proxy *serverProxy) string {
	t.Helper()
	srv := httptest.NewServer(proxy)
	t.Cleanup(srv.Close)
	return srv.URL + "/api/v1/jobs?page=2"
}

// TestServerProxyResolvesTheAddressPerRequest is the heart of the design:
// the lookup runs on every request, so a server restarted on a new port is
// followed without rebuilding the proxy.
func TestServerProxyResolvesTheAddressPerRequest(t *testing.T) {
	var hitsA, hitsB atomic.Int32
	backendA := startBackend(t, &hitsA, nil)
	backendB := startBackend(t, &hitsB, nil)
	current := backendA.Listener.Addr().String()
	proxy := newServerProxy(http.HandlerFunc(staticHandler), func() (string, bool) {
		return current, true
	}, testLogger())
	client := &http.Client{Timeout: 0}

	get := func() {
		t.Helper()
		resp, err := client.Get(proxyURL(t, proxy))
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		resp.Body.Close()
	}

	get()
	if hitsA.Load() != 1 || hitsB.Load() != 0 {
		t.Fatalf("first request hits: A=%d B=%d, want A=1 B=0", hitsA.Load(), hitsB.Load())
	}

	// The server "restarts" on the other backend.
	current = backendB.Listener.Addr().String()
	get()
	if hitsA.Load() != 1 || hitsB.Load() != 1 {
		t.Fatalf("second request hits: A=%d B=%d, want A=1 B=1", hitsA.Load(), hitsB.Load())
	}
}

// TestServerProxyStoppedServerAnswers503: a lookup that reports no running
// server must produce the documented JSON error, not a dial error.
func TestServerProxyStoppedServerAnswers503(t *testing.T) {
	proxy := newServerProxy(http.HandlerFunc(staticHandler), func() (string, bool) {
		return "", false
	}, testLogger())
	resp, err := http.Get(proxyURL(t, proxy))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	var payload map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if payload["error"] != "server not running" {
		t.Fatalf("error = %q, want %q", payload["error"], "server not running")
	}
}

// TestServerProxyDeadAddressAnswers502 covers the narrow race between a
// positive lookup and a server that died before the dial.
func TestServerProxyDeadAddressAnswers502(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	addr := dead.Listener.Addr().String()
	dead.Close()

	var logBuf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logBuf, nil))
	proxy := newServerProxy(http.HandlerFunc(staticHandler), func() (string, bool) {
		return addr, true
	}, log)
	resp, err := http.Get(proxyURL(t, proxy))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	var payload map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if payload["error"] != "server unreachable" {
		t.Fatalf("error = %q, want %q", payload["error"], "server unreachable")
	}
	// The 502 must leave a trail for the GUI's log viewer.
	if !strings.Contains(logBuf.String(), "asset proxy request failed") || !strings.Contains(logBuf.String(), addr) {
		t.Fatalf("log = %q, want the proxy failure with the dead address", logBuf.String())
	}
}

// TestServerProxyServesStaticElsewhere: everything outside /api/ stays on
// the embedded build — that is what makes the app shell load.
func TestServerProxyServesStaticElsewhere(t *testing.T) {
	var hits atomic.Int32
	backend := startBackend(t, &hits, nil)
	proxy := newServerProxy(http.HandlerFunc(staticHandler), func() (string, bool) {
		return backend.Listener.Addr().String(), true
	}, testLogger())

	srv := httptest.NewServer(proxy)
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/assets/index-a1b2.js")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if got, want := body(t, resp), "static:/assets/index-a1b2.js"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if hits.Load() != 0 {
		t.Fatalf("backend hits = %d, want 0 (no proxying outside /api/)", hits.Load())
	}
}

// TestServerProxySendsDialedHostAsHostHeader pins the upstream Host header
// to the dialed address (SetURL behavior): the server must not see the
// webview's wails:// origin name.
func TestServerProxySendsDialedHostAsHostHeader(t *testing.T) {
	var hits atomic.Int32
	var sawHost atomic.Value
	backend := startBackend(t, &hits, &sawHost)
	proxy := newServerProxy(http.HandlerFunc(staticHandler), func() (string, bool) {
		return backend.Listener.Addr().String(), true
	}, testLogger())

	resp, err := http.Get(proxyURL(t, proxy))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if got := sawHost.Load(); got != backend.Listener.Addr().String() {
		t.Fatalf("upstream Host = %v, want %v", got, backend.Listener.Addr().String())
	}
}
