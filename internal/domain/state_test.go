package domain

import "testing"

func TestIsPaused(t *testing.T) {
	cases := map[string]bool{
		StatePausedDL:    true,
		StatePausedUP:    true,
		"stoppedDL":      true, // qBittorrent 5: stopped means paused
		"stoppedUP":      true,
		"PausedDL":       true,
		StateDownloading: false,
		StateSeeding:     false,
		StateQueued:      false,
		StateError:       false,
		"uploading":      false,
		"stalledUP":      false,
		"":               false,
	}
	for state, want := range cases {
		if got := IsPaused(state); got != want {
			t.Errorf("IsPaused(%q) = %v, want %v", state, got, want)
		}
	}
}
