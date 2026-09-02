package domain

import "strings"

// Canonical download states. Every TorrentEngine adapter emits these from its
// boundary (ports.go). Downloads persisted before the canonical vocabulary
// carry raw qBittorrent strings; the helpers here accept both vocabularies so
// old rows keep working without migration.
const (
	StateDownloading = "downloading"
	StateSeeding     = "seeding"
	StatePausedDL    = "pausedDL"
	StatePausedUP    = "pausedUP"
	StateQueued      = "queued"
	StateError       = "error"
)

// IsPaused reports whether a download must be resumed before playback.
// Accepts the canonical vocabulary and legacy qBittorrent strings, including
// the qBittorrent 5 stoppedDL/stoppedUP forms that mean paused.
func IsPaused(state string) bool {
	s := strings.ToLower(state)
	return strings.HasPrefix(s, "paused") || s == "stoppeddl" || s == "stoppedup"
}
