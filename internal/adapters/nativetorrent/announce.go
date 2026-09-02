package nativetorrent

import (
	"context"
	"crypto/rand"
	"log/slog"
	"math/big"
	"sync"
)

// FileList's tracker maintains a client allowlist and rejects announces with
// "Your client is not allowed!" for unknown peer IDs and user agents. The
// household already runs qBittorrent 4.4.1, so the native engine presents the
// same identity: an allowed client that this deployment genuinely mirrors.
const (
	peerIDPrefix   = "-qB4410-"
	peerIDShortLen = 12
	peerIDCharset  = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	trackerUA      = "qBittorrent/4.4.1"
)

// trackerIdentity returns the peer ID (exactly 20 bytes) and HTTP user agent
// the engine presents to trackers. The suffix is random per client, matching
// qBittorrent's own behaviour.
func newTrackerIdentity() (peerID string, userAgent string) {
	suffix := make([]byte, peerIDShortLen)
	for i := range suffix {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(peerIDCharset))))
		if err != nil {
			panic(err) // crypto/rand failure is unrecoverable
		}
		suffix[i] = peerIDCharset[n.Int64()]
	}
	return peerIDPrefix + string(suffix), trackerUA
}

// announceCapture records the latest tracker announce outcome per torrent so
// a refused announce (e.g. a client allowlist rejection) is visible in
// Status instead of masquerading as a healthy "downloading 0%".
type announceCapture struct {
	mu   sync.Mutex
	errs map[string]string
}

func newAnnounceCapture() *announceCapture {
	return &announceCapture{errs: map[string]string{}}
}

// Error returns the latest announce failure for the infohash hex, if any.
func (a *announceCapture) Error(infoHashHex string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.errs[infoHashHex]
}

func (a *announceCapture) clear(infoHashHex string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.errs, infoHashHex)
}

// Handler returns the slog handler the torrent client logs announces through.
// The library emits `announced` records carrying the torrent group (name, ih)
// and an err attr that is nil on success.
func (a *announceCapture) Handler() slog.Handler {
	return &announceHandler{capture: a}
}

type announceHandler struct {
	capture *announceCapture
	attrs   []slog.Attr
}

func (h *announceHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *announceHandler) Handle(_ context.Context, r slog.Record) error {
	if r.Message != "announced" {
		return nil
	}
	attrs := append([]slog.Attr(nil), h.attrs...)
	r.Attrs(func(attr slog.Attr) bool { attrs = append(attrs, attr); return true })
	var ih string
	var errText *string
	for _, attr := range attrs {
		switch {
		case attr.Key == "torrent" && attr.Value.Kind() == slog.KindGroup:
			for _, inner := range attr.Value.Group() {
				if inner.Key == "ih" {
					ih = inner.Value.String()
				}
			}
		case attr.Key == "err":
			if err, ok := attr.Value.Any().(error); ok && err != nil {
				text := err.Error()
				errText = &text
			}
		}
	}
	if ih == "" {
		return nil
	}
	h.capture.mu.Lock()
	if errText == nil {
		delete(h.capture.errs, ih)
	} else {
		h.capture.errs[ih] = *errText
	}
	h.capture.mu.Unlock()
	return nil
}

func (h *announceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &announceHandler{capture: h.capture, attrs: append(append([]slog.Attr(nil), h.attrs...), attrs...)}
}

func (h *announceHandler) WithGroup(string) slog.Handler { return h }
