package nativetorrent

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"
)

// buildTestMetainfo builds a real multi-file metainfo from files on disk and
// returns the parsed MetaInfo plus the raw bencode bytes a FileList download
// would deliver.
func buildTestMetainfo(t *testing.T, root string) (mi metainfo.MetaInfo, raw []byte) {
	t.Helper()
	var info metainfo.Info
	private := true
	info.Private = &private
	if err := info.BuildFromFilePath(root); err != nil {
		t.Fatal(err)
	}
	b, err := bencode.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	mi = metainfo.MetaInfo{InfoBytes: b}
	raw, err = bencode.Marshal(mi)
	if err != nil {
		t.Fatal(err)
	}
	return mi, raw
}

func newTestClient(t *testing.T) *Client {
	t.Helper()
	c, err := New(Config{
		DataDir:     t.TempDir(),
		SessionDir:  t.TempDir(),
		PeerPort:    0,
		Readahead:   1 << 20,
		StartWindow: 1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func seedContent(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Pack.S01.1080p")
	if err := os.MkdirAll(filepath.Join(root, "Subs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Pack.S01E01.mkv"), bytes.Repeat([]byte("a"), 4<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Pack.S01E02.mkv"), bytes.Repeat([]byte("b"), 4<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Subs", "E01.srt"), []byte("1\n00:00:01,000 --> 00:00:02,000\nhi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestAddExposesFilesWithOffsets(t *testing.T) {
	root := seedContent(t)
	_, raw := buildTestMetainfo(t, root)
	c := newTestClient(t)

	hash, err := c.Add(t.Context(), bytes.NewReader(raw), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(hash) != 40 {
		t.Fatalf("expected 40-char infohash hex, got %q", hash)
	}
	files, err := c.Files(t.Context(), hash)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 {
		t.Fatalf("expected 3 files, got %d", len(files))
	}
	var offset int64
	for i, f := range files {
		if f.Index != i {
			t.Errorf("file %d has Index %d", i, f.Index)
		}
		if f.Offset != offset {
			t.Errorf("file %d Offset = %d, want %d", i, f.Offset, offset)
		}
		offset += f.SizeBytes
	}
	if files[0].Path != "Pack.S01.1080p/Pack.S01E01.mkv" || !files[0].Playable {
		t.Errorf("unexpected first file %+v", files[0])
	}
	if files[2].Playable {
		t.Errorf("srt must not be playable: %+v", files[2])
	}
}

func TestAddIsIdempotent(t *testing.T) {
	root := seedContent(t)
	_, raw := buildTestMetainfo(t, root)
	c := newTestClient(t)
	h1, err := c.Add(t.Context(), bytes.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	h2, err := c.Add(t.Context(), bytes.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("duplicate add returned %q then %q", h1, h2)
	}
	if got := len(c.cl.Torrents()); got != 1 {
		t.Fatalf("expected 1 torrent in client, got %d", got)
	}
}

func TestTestReportsTorrentCount(t *testing.T) {
	c := newTestClient(t)
	msg, err := c.Test(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if msg == "" {
		t.Fatal("Test must return a diagnostic string")
	}
}
