// Package nativetorrent implements the TorrentEngine port with an embedded
// anacrolix/torrent client. Media bytes land at
// <DataDir>/<infohash-hex>/<torrent-relative path> so the application's
// disk-first progressive serving reads them exactly like qBittorrent content.
package nativetorrent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	g "github.com/anacrolix/generics"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
)

// Config is the native engine's deployment surface.
type Config struct {
	// DataDir holds media files: <DataDir>/<infohash-hex>/<torrent-relative path>.
	DataDir string
	// SessionDir holds session.json and the bolt piece-completion database.
	SessionDir string
	// PeerPort is the BitTorrent listen port; 0 lets the OS assign one.
	PeerPort int
	// Readahead is the seek-window size in bytes.
	Readahead int64
	// StartWindow is the window elevated when a file is first prepared.
	StartWindow int64
}

type Client struct {
	cl      *torrent.Client
	dataDir string
	cfg     Config
	// stop closes to end the speed sampler's loop (Task 5).
	stop chan struct{}

	mu      sync.Mutex
	session *sessionStore
}

// New constructs the engine and reloads every persisted torrent from the
// session store.
func New(cfg Config) (*Client, error) {
	if cfg.DataDir == "" || cfg.SessionDir == "" {
		return nil, errors.New("native engine requires dataDir and sessionDir")
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("native engine data dir: %w", err)
	}
	if err := os.MkdirAll(cfg.SessionDir, 0o755); err != nil {
		return nil, fmt.Errorf("native engine session dir: %w", err)
	}
	pc, err := storage.NewBoltPieceCompletion(cfg.SessionDir)
	if err != nil {
		return nil, fmt.Errorf("native engine piece completion db: %w", err)
	}
	impl := storage.NewFileOpts(storage.NewFileClientOpts{
		ClientBaseDir: cfg.DataDir,
		// Torrent display names are arbitrary tracker bytes and can be invalid
		// path components (a colon on Windows); key the layout by infohash.
		TorrentDirMaker: func(baseDir string, _ *metainfo.Info, ih metainfo.Hash) string {
			return filepath.Join(baseDir, ih.HexString())
		},
		// Pieces must write in place at their final paths: playback reads the
		// files directly, and part-file promotion would hide incomplete bytes
		// behind a .part rename until completion.
		UsePartFiles:    g.Some(false),
		PieceCompletion: pc,
	})
	tcfg := torrent.NewDefaultClientConfig()
	tcfg.DataDir = cfg.DataDir
	tcfg.DefaultStorage = impl
	tcfg.NoDHT = true                   // FileList is a private tracker; torrents are private-flagged
	tcfg.NoDefaultPortForwarding = true // household appliance; never poke the router
	tcfg.Seed = true                    // seed until eviction
	tcfg.ListenPort = cfg.PeerPort
	cl, err := torrent.NewClient(tcfg)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("native torrent client: %w", err)
	}
	c := &Client{
		cl:      cl,
		dataDir: cfg.DataDir,
		cfg:     cfg,
		stop:    make(chan struct{}),
		session: newSessionStore(cfg.SessionDir, pc),
	}
	if err := c.loadSession(); err != nil {
		_ = cl.Close()
		_ = pc.Close()
		return nil, fmt.Errorf("native engine session reload: %w", err)
	}
	go c.speedLoop()
	return c, nil
}

func (c *Client) Close() error {
	c.stopSpeedLoop()
	errs := c.cl.Close()
	if c.session.pc != nil {
		if err := c.session.pc.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// torrent returns the live torrent for an infohash hex string, or nil.
func (c *Client) torrent(hash string) *torrent.Torrent {
	var ih metainfo.Hash
	// metainfo.NewHashFromHex panics on malformed hex in v1.61.0; the method
	// form returns an error instead.
	if err := ih.FromHexString(hash); err != nil {
		return nil
	}
	for _, t := range c.cl.Torrents() {
		if t.InfoHash() == ih {
			return t
		}
	}
	return nil
}

// Add registers a .torrent (bencode metainfo from the tracker) and returns
// its infohash hex. Adding an infohash the engine already holds is
// idempotent. Nothing downloads until PrepareFiles selects files.
func (c *Client) Add(ctx context.Context, r io.Reader, _ string) (string, error) {
	raw, err := io.ReadAll(io.LimitReader(r, 16<<20))
	if err != nil {
		return "", fmt.Errorf("read torrent metainfo: %w", err)
	}
	mi, err := metainfo.Load(bytes.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("torrent metainfo: %w", err)
	}
	hash := mi.HashInfoBytes().HexString()
	c.mu.Lock()
	defer c.mu.Unlock()
	if t := c.torrent(hash); t != nil {
		return hash, nil
	}
	t, err := c.cl.AddTorrent(mi)
	if err != nil {
		return "", fmt.Errorf("add torrent: %w", err)
	}
	// FileList metainfo carries the info dictionary, so metadata is
	// effectively immediate; wait briefly rather than assume.
	if err := waitInfo(ctx, t); err != nil {
		return "", err
	}
	if err := c.session.putMeta(hash, raw); err != nil {
		return "", fmt.Errorf("persist torrent session: %w", err)
	}
	return hash, nil
}

func waitInfo(ctx context.Context, t *torrent.Torrent) error {
	deadline := time.Now().Add(5 * time.Second)
	for t.Info() == nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().After(deadline) {
			return errors.New("native engine torrent metadata timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

// Files lists the torrent's files in metainfo order with cumulative byte
// offsets. An empty slice means metadata is not ready yet; the caller polls.
func (c *Client) Files(_ context.Context, hash string) ([]domain.TorrentFile, error) {
	t := c.torrent(hash)
	if t == nil {
		return nil, domain.ErrTorrentNotFound
	}
	if t.Info() == nil {
		return []domain.TorrentFile{}, nil
	}
	files := t.Files()
	out := make([]domain.TorrentFile, 0, len(files))
	for i, f := range files {
		size := f.Length()
		progress := 0.0
		if size > 0 {
			progress = float64(f.BytesCompleted()) / float64(size)
		}
		out = append(out, domain.TorrentFile{
			Index:     i,
			Path:      f.Path(),
			SizeBytes: size,
			Offset:    f.Offset(),
			Progress:  progress,
			Playable:  playable(f.Path()),
		})
	}
	return out, nil
}

// Test reports a diagnostic for the settings test endpoint.
func (c *Client) Test(_ context.Context) (string, error) {
	n := len(c.cl.Torrents())
	if addrs := c.cl.ListenAddrs(); len(addrs) > 0 {
		if tcp, ok := addrs[0].(*net.TCPAddr); ok {
			return fmt.Sprintf("native torrent engine: %d torrents, peer port %d", n, tcp.Port), nil
		}
	}
	return fmt.Sprintf("native torrent engine: %d torrents", n), nil
}

// playable mirrors the qbit adapter's media-extension test; the adapters stay
// deliberately independent.
func playable(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".mkv", ".avi", ".webm", ".mov", ".m4v", ".ts", ".mpg", ".mpeg":
		return true
	default:
		return false
	}
}

// speedLoop samples per-torrent download rates until Close; the real sampler
// lands in Task 5.
func (c *Client) speedLoop() {}

// stopSpeedLoop ends the speed sampler; the real implementation lands in
// Task 5.
func (c *Client) stopSpeedLoop() {}
