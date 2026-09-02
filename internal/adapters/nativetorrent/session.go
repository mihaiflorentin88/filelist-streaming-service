package nativetorrent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/anacrolix/torrent/storage"
)

// sessionEntry is everything the engine needs to restore a torrent after a
// restart: its metainfo, the file selection, and the paused flag. Piece
// completion lives in the bolt db beside this file, so completed pieces are
// never re-verified.
type sessionEntry struct {
	Metainfo        []byte `json:"metainfo"`
	MediaIndices    []int  `json:"mediaIndices,omitempty"`
	SubtitleIndices []int  `json:"subtitleIndices,omitempty"`
	Paused          bool   `json:"paused,omitempty"`
}

type sessionStore struct {
	path    string
	pc      storage.PieceCompletion
	mu      sync.Mutex
	entries map[string]sessionEntry
}

func newSessionStore(dir string, pc storage.PieceCompletion) *sessionStore {
	s := &sessionStore{
		path:    filepath.Join(dir, "session.json"),
		pc:      pc,
		entries: map[string]sessionEntry{},
	}
	if raw, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(raw, &s.entries)
	}
	return s
}

func (s *sessionStore) save() error {
	raw, err := json.MarshalIndent(s.entries, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *sessionStore) putMeta(hash string, raw []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[hash]
	e.Metainfo = raw
	s.entries[hash] = e
	return s.save()
}

func (s *sessionStore) setSelection(hash string, media, subs []int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[hash]
	e.MediaIndices, e.SubtitleIndices = media, subs
	s.entries[hash] = e
	return s.save()
}

func (s *sessionStore) setPaused(hash string, paused bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[hash]
	e.Paused = paused
	s.entries[hash] = e
	return s.save()
}

func (s *sessionStore) delete(hash string, _ bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, hash)
	return s.save()
}

func (s *sessionStore) lookup(hash string) (media, subs []int, paused bool, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[hash]
	return e.MediaIndices, e.SubtitleIndices, e.Paused, ok
}
