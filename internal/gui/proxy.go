package gui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// addrKey carries the per-request upstream address from ServeHTTP into the
// ReverseProxy's Rewrite, which the httputil package runs after the lookup.
type addrKey struct{}

// serverProxy is the wails asset server's handler. The webview's origin is
// the app scheme (wails://…), so the shared views' fetches only reach the
// supervised server if they stay same-origin: /api/ paths are reverse-
// proxied to the server's CURRENT dialable address — resolved per request
// through the lookup, never cached, so a restart on another port keeps
// working — and every other path falls through to the embedded vite build.
// A stopped server answers 503 {"error":"server not running"} instead of
// pointing the views at a dead origin.
//
// The lookup returns the raw listen address (":8097" and "127.0.0.1:8097"
// both dial loopback), not the display form the state events carry.
type serverProxy struct {
	static http.Handler
	proxy  *httputil.ReverseProxy
	lookup func() (string, bool)
}

// newServerProxy layers /api/ proxying over the embedded static handler.
func newServerProxy(static http.Handler, lookup func() (string, bool)) *serverProxy {
	p := &serverProxy{static: static, lookup: lookup}
	p.proxy = &httputil.ReverseProxy{
		Rewrite: func(req *httputil.ProxyRequest) {
			addr, _ := req.In.Context().Value(addrKey{}).(string)
			// SetURL retargets scheme/host and makes the outbound Host
			// header the dialed address; the request path is kept.
			req.SetURL(&url.URL{Scheme: "http", Host: addr})
		},
		// Only reachable when the address looked up as running refused the
		// connection (the server died between lookup and dial).
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeProxyError(w, http.StatusBadGateway, "server unreachable")
		},
	}
	return p
}

func (p *serverProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		p.static.ServeHTTP(w, r)
		return
	}
	addr, ok := p.lookup()
	if !ok {
		writeProxyError(w, http.StatusServiceUnavailable, "server not running")
		return
	}
	ctx := context.WithValue(r.Context(), addrKey{}, addr)
	p.proxy.ServeHTTP(w, r.WithContext(ctx))
}

func writeProxyError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
