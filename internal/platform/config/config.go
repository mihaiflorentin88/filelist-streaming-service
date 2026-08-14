package config

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const DefaultSettingsPath = "data/settings.json"

type Settings struct {
	ListenAddress              string   `json:"listenAddress"`
	TrustedCIDRs               []string `json:"trustedCidrs"`
	DatabasePath               string   `json:"databasePath"`
	DownloadRoot               string   `json:"downloadRoot"`
	FileListURL                string   `json:"fileListUrl"`
	FileListUsername           string   `json:"fileListUsername"`
	FileListPasskey            string   `json:"fileListPasskey,omitempty"`
	QBittorrentURL             string   `json:"qbittorrentUrl"`
	QBittorrentUsername        string   `json:"qbittorrentUsername"`
	QBittorrentPassword        string   `json:"qbittorrentPassword,omitempty"`
	InitialBufferBytes         int64    `json:"initialBufferBytes"`
	ReadAheadBytes             int64    `json:"readAheadBytes"`
	PieceWaitTimeoutSeconds    int      `json:"pieceWaitTimeoutSeconds"`
	CatalogMaxAgeHours         int      `json:"catalogMaxAgeHours"`
	MaximumDownloadBytes       int64    `json:"maximumDownloadBytes"`
	ReserveFreeBytes           int64    `json:"reserveFreeBytes"`
	PreferredSubtitleLanguage  string   `json:"preferredSubtitleLanguage"`
	FallbackSubtitleLanguage   string   `json:"fallbackSubtitleLanguage"`
	PreferredAudioLanguage     string   `json:"preferredAudioLanguage"`
	TMDBAPIKey                 string   `json:"tmdbApiKey,omitempty"`
	MetadataLanguage           string   `json:"metadataLanguage"`
	MetadataFallbackLanguage   string   `json:"metadataFallbackLanguage"`
	ArtworkCachePath           string   `json:"artworkCachePath"`
	ArtworkCacheMaxBytes       int64    `json:"artworkCacheMaxBytes"`
	SubDLURL                   string   `json:"subDLUrl"`
	SubDLAPIKey                string   `json:"subDLApiKey,omitempty"`
	SubtitleCachePath          string   `json:"subtitleCachePath"`
	SubtitleCacheMaxBytes      int64    `json:"subtitleCacheMaxBytes"`
	FFprobePath                string   `json:"ffprobePath"`
	FFmpegPath                 string   `json:"ffmpegPath"`
	WatchedThresholdPercent    int      `json:"watchedThresholdPercent"`
	MaxConcurrentJobs          int      `json:"maxConcurrentJobs"`
	TitleRefreshTimeoutMinutes int      `json:"titleRefreshTimeoutMinutes"`
}

func Defaults() Settings {
	return Settings{
		ListenAddress: ":8097", TrustedCIDRs: []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}, DatabasePath: "data/filelist.db",
		DownloadRoot: "/srv/filelist-downloads", FileListURL: "https://filelist.io", QBittorrentURL: "http://127.0.0.1:8080",
		InitialBufferBytes: 128 << 20, ReadAheadBytes: 256 << 20, PieceWaitTimeoutSeconds: 600, CatalogMaxAgeHours: 24,
		MaximumDownloadBytes: 15 << 30, ReserveFreeBytes: 8 << 30, PreferredSubtitleLanguage: "ro", FallbackSubtitleLanguage: "en", PreferredAudioLanguage: "en",
		MetadataLanguage: "ro-RO", MetadataFallbackLanguage: "en-US", ArtworkCachePath: "data/artwork", ArtworkCacheMaxBytes: 512 << 20,
		SubDLURL: "https://api.subdl.com", MaxConcurrentJobs: 10, TitleRefreshTimeoutMinutes: 30,
		SubtitleCachePath: "data/subtitles", SubtitleCacheMaxBytes: 256 << 20,
		FFprobePath: "/usr/bin/ffprobe", FFmpegPath: "/usr/bin/ffmpeg",
		WatchedThresholdPercent: 90,
	}
}

type Store struct {
	mu    sync.RWMutex
	path  string
	value Settings
}

func Load() (*Store, error) {
	s := &Store{path: DefaultSettingsPath, value: Defaults()}
	b, err := os.ReadFile(s.path)
	if err == nil {
		if err = json.Unmarshal(b, &s.value); err != nil {
			return nil, fmt.Errorf("decode settings: %w", err)
		}
		if s.value.WatchedThresholdPercent == 0 {
			s.value.WatchedThresholdPercent = 90
		}
		if s.value.PreferredAudioLanguage == "" {
			s.value.PreferredAudioLanguage = "en"
		}
		if s.value.MetadataLanguage == "" {
			s.value.MetadataLanguage = "ro-RO"
		}
		if s.value.MetadataFallbackLanguage == "" {
			s.value.MetadataFallbackLanguage = "en-US"
		}
		if s.value.ArtworkCachePath == "" {
			s.value.ArtworkCachePath = "data/artwork"
		}
		if s.value.ArtworkCacheMaxBytes == 0 {
			s.value.ArtworkCacheMaxBytes = 512 << 20
		}
		if s.value.SubDLURL == "" {
			s.value.SubDLURL = "https://api.subdl.com"
		}
		if s.value.MaxConcurrentJobs == 0 {
			s.value.MaxConcurrentJobs = 10
		}
		if s.value.TitleRefreshTimeoutMinutes == 0 {
			s.value.TitleRefreshTimeoutMinutes = 30
		}
		if s.value.FFprobePath == "" {
			s.value.FFprobePath = "/usr/bin/ffprobe"
		}
		if s.value.FFmpegPath == "" {
			s.value.FFmpegPath = "/usr/bin/ffmpeg"
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if err := s.validate(s.value); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(s.value.DatabasePath), 0o750); err != nil {
		return nil, err
	}
	return s, nil
}
func (s *Store) Get() Settings { s.mu.RLock(); defer s.mu.RUnlock(); return s.value }
func (s *Store) Path() string  { return s.path }
func (s *Store) Save(next Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	mergeSecrets(&next, s.value)
	if err := s.validate(next); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o750); err != nil {
		return err
	}
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err = os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err = os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	if err = os.Rename(tmp, s.path); err != nil {
		return err
	}
	s.value = next
	return nil
}
func (s *Store) TrustedPrefixes() []netip.Prefix {
	v := s.Get()
	out := make([]netip.Prefix, 0, len(v.TrustedCIDRs))
	for _, raw := range v.TrustedCIDRs {
		if p, e := netip.ParsePrefix(raw); e == nil {
			out = append(out, p)
		}
	}
	return out
}
func (s *Store) PieceWaitTimeout() time.Duration {
	return time.Duration(s.Get().PieceWaitTimeoutSeconds) * time.Second
}
func (s *Store) CatalogMaxAge() time.Duration {
	return time.Duration(s.Get().CatalogMaxAgeHours) * time.Hour
}
func (s *Store) validate(v Settings) error {
	if v.ListenAddress == "" || v.DatabasePath == "" || v.DownloadRoot == "" {
		return fmt.Errorf("listenAddress, databasePath, and downloadRoot are required")
	}
	if v.InitialBufferBytes < 16<<20 || v.InitialBufferBytes > 2<<30 {
		return fmt.Errorf("initialBufferBytes must be between 16 MiB and 2 GiB")
	}
	if v.ReadAheadBytes < v.InitialBufferBytes || v.ReadAheadBytes > 2<<30 {
		return fmt.Errorf("readAheadBytes must be between initialBufferBytes and 2 GiB")
	}
	if v.PieceWaitTimeoutSeconds < 1 {
		return fmt.Errorf("pieceWaitTimeoutSeconds must be positive")
	}
	if v.WatchedThresholdPercent < 50 || v.WatchedThresholdPercent > 100 {
		return fmt.Errorf("watchedThresholdPercent must be between 50 and 100")
	}
	if v.SubtitleCachePath == "" || v.SubtitleCacheMaxBytes < 1<<20 || v.SubtitleCacheMaxBytes > 4<<30 {
		return fmt.Errorf("subtitleCachePath is required and subtitleCacheMaxBytes must be between 1 MiB and 4 GiB")
	}
	if v.FFprobePath == "" || v.FFmpegPath == "" || !filepath.IsAbs(v.FFprobePath) || !filepath.IsAbs(v.FFmpegPath) {
		return fmt.Errorf("ffprobePath and ffmpegPath must be absolute paths")
	}
	if v.ArtworkCachePath == "" || v.ArtworkCacheMaxBytes < 16<<20 || v.ArtworkCacheMaxBytes > 8<<30 {
		return fmt.Errorf("artworkCachePath is required and artworkCacheMaxBytes must be between 16 MiB and 8 GiB")
	}
	for label, raw := range map[string]string{"SubDL API URL": v.SubDLURL} {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return fmt.Errorf("%s must be an absolute URL", label)
		}
	}
	if !strings.EqualFold(strings.TrimSpace(strings.TrimRight(v.SubDLURL, "/")), "https://api.subdl.com") {
		return fmt.Errorf("SubDL API URL must use https://api.subdl.com")
	}
	if v.MaxConcurrentJobs < 1 || v.MaxConcurrentJobs > 20 {
		return fmt.Errorf("maxConcurrentJobs must be between 1 and 20")
	}
	if v.TitleRefreshTimeoutMinutes < 5 || v.TitleRefreshTimeoutMinutes > 120 {
		return fmt.Errorf("titleRefreshTimeoutMinutes must be between 5 and 120")
	}
	for _, raw := range v.TrustedCIDRs {
		if _, err := netip.ParsePrefix(raw); err != nil {
			return fmt.Errorf("invalid trusted CIDR %q", raw)
		}
	}
	return nil
}
func mergeSecrets(next *Settings, old Settings) {
	if next.FileListPasskey == "" {
		next.FileListPasskey = old.FileListPasskey
	}
	if next.QBittorrentPassword == "" {
		next.QBittorrentPassword = old.QBittorrentPassword
	}
	if next.TMDBAPIKey == "" {
		next.TMDBAPIKey = old.TMDBAPIKey
	}
	if next.SubDLAPIKey == "" {
		next.SubDLAPIKey = old.SubDLAPIKey
	}
}
