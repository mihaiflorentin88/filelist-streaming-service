package nativetorrent

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestTrackerIdentityMimicsAllowlistedClient(t *testing.T) {
	peerID, userAgent := newTrackerIdentity()
	if len(peerID) != 20 {
		t.Fatalf("peer id must be 20 bytes, got %d", len(peerID))
	}
	if !strings.HasPrefix(peerID, "-qB4430-") {
		t.Fatalf("peer id must carry the qBittorrent 4.4.0 prefix, got %q", peerID)
	}
	if userAgent != "qBittorrent/4.4.1" {
		t.Fatalf("user agent = %q", userAgent)
	}
	other, _ := newTrackerIdentity()
	if other == peerID {
		t.Fatal("peer id suffix must be random per client")
	}
	for _, r := range peerID[8:] {
		if r < 33 || r > 126 {
			t.Fatalf("peer id suffix must be printable, got %q", peerID)
		}
	}
}

func TestAnnounceCaptureRecordsTrackerFailure(t *testing.T) {
	capture := newAnnounceCapture()
	logger := slog.New(capture.Handler()).With(makeTorrentGroup("Silo", "abc123"))

	failure := errors.New(`tracker gave failure reason: "Your client is not allowed!"`)
	logger.Log(context.Background(), 0, "announcing", "req", "r")
	logger.Log(context.Background(), 0, "announced", "resp", "x", "err", failure)

	if got := capture.Error("abc123"); got == "" || !strings.Contains(got, "not allowed") {
		t.Fatalf("failure must be captured for the infohash, got %q", got)
	}

	logger.Log(context.Background(), 0, "announced", "resp", "x", "err", nil)
	if got := capture.Error("abc123"); got != "" {
		t.Fatalf("a successful announce must clear the stored error, got %q", got)
	}
}

func TestAnnounceCaptureIgnoresForeignMessages(t *testing.T) {
	capture := newAnnounceCapture()
	logger := slog.New(capture.Handler()).With(makeTorrentGroup("Silo", "abc123"))
	logger.Log(context.Background(), 0, "announcing", "req", "r")
	if got := capture.Error("abc123"); got != "" {
		t.Fatalf("interim messages must not produce errors, got %q", got)
	}
}

func TestAnnounceCaptureClearRemovesEntry(t *testing.T) {
	capture := newAnnounceCapture()
	capture.errs["deadbeef"] = "stale"
	capture.clear("deadbeef")
	if got := capture.Error("deadbeef"); got != "" {
		t.Fatalf("clear must drop the entry, got %q", got)
	}
}

func TestStatusSurfacesTrackerError(t *testing.T) {
	c := newTestClient(t)
	_, raw := buildTestMetainfo(t, t.TempDir())
	hash, err := c.Add(t.Context(), bytes.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	c.announce.errs[hash] = `tracker gave failure reason: "Your client is not allowed!"`
	status, err := c.Status(t.Context(), hash)
	if err != nil {
		t.Fatal(err)
	}
	if status.TrackerError == "" {
		t.Fatal("Status must surface the captured tracker error")
	}
}

func makeTorrentGroup(name, ih string) slog.Attr {
	return slog.Group("torrent", "name", name, "ih", ih)
}
