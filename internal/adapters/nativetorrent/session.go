package nativetorrent

import (
	"path/filepath"

	"github.com/anacrolix/torrent/storage"
)

// sessionEntry is the persisted per-torrent selection state.
type sessionEntry struct {
	MediaIndices    []int
	SubtitleIndices []int
	Paused          bool
}

// sessionStore persists torrent selections across restarts. Task 4 stub:
// in-memory only; Task 7 makes it durable via session.json.
type sessionStore struct {
	path    string
	pc      storage.PieceCompletion
	entries map[string]sessionEntry
}

func newSessionStore(dir string, pc storage.PieceCompletion) *sessionStore {
	return &sessionStore{path: filepath.Join(dir, "session.json"), pc: pc, entries: map[string]sessionEntry{}}
}

func (s *sessionStore) putMeta(string, []byte) error             { return nil }
func (s *sessionStore) setSelection(string, []int, []int) error  { return nil }
func (s *sessionStore) setPaused(string, bool) error             { return nil }
func (s *sessionStore) delete(string, bool) error                { return nil }
func (s *sessionStore) lookup(string) ([]int, []int, bool, bool) { return nil, nil, false, false }

// loadSession re-adds persisted torrents to a fresh client. Task 4 stub:
// nothing persisted yet; Task 7 replaces the body.
func (c *Client) loadSession() error { return nil }
