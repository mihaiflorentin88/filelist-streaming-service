package nativetorrent

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestSessionRoundTripReloadsTorrents(t *testing.T) {
	root := seedContent(t)
	_, raw := buildTestMetainfo(t, root)

	dir := t.TempDir()
	c := newTestClientAt(t, dir)
	hash, err := c.Add(t.Context(), bytes.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	files, err := c.Files(t.Context(), hash)
	if err != nil {
		t.Fatal(err)
	}
	e01 := files[0].Index
	if err := c.PrepareFiles(t.Context(), hash, []int{e01}, []int{2}); err != nil {
		t.Fatal(err)
	}
	if err := c.Pause(t.Context(), hash); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}

	// A fresh engine over the same session dir must re-add the torrent and
	// re-apply the selection without re-fetching anything.
	c2, err := New(Config{DataDir: c.dataDir, SessionDir: filepath.Join(dir, "session"), PeerPort: 0, Readahead: 1 << 20, StartWindow: 1 << 20})
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if got := len(c2.cl.Torrents()); got != 1 {
		t.Fatalf("reloaded engine must hold 1 torrent, got %d", got)
	}
	media, subs, paused, ok := c2.session.lookup(hash)
	if !ok || len(media) != 1 || media[0] != e01 || len(subs) != 1 || !paused {
		t.Fatalf("session entry lost or wrong: media=%v subs=%v paused=%v ok=%v", media, subs, paused, ok)
	}
}
