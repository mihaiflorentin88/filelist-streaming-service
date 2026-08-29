package httpapi

import (
	"context"
	"io"
	"log/slog"
	"os/exec"
	"path/filepath"
	"testing"
)

// snapFixture builds a 12s synthetic MKV with keyframes every 2s and returns
// its path; the test skips when ffmpeg is unavailable.
func snapFixture(t *testing.T) string {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not available")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not available")
	}
	path := filepath.Join(t.TempDir(), "snap.mkv")
	out, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=duration=12:size=128x72:rate=24",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=12",
		"-map", "0:v", "-map", "1:a",
		"-c:v", "libx264", "-g", "48", "-keyint_min", "48",
		"-c:a", "aac",
		path,
	).CombinedOutput()
	if err != nil {
		t.Skipf("fixture encode failed: %v: %s", err, out)
	}
	return path
}

func TestSnapStartToVideoKeyframe(t *testing.T) {
	path := snapFixture(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// 5s target snaps back onto the 4s keyframe; sync demands both streams
	// start on the same content point, and copied video cannot start mid-GOP.
	if got := snapStartToVideoKeyframe(context.Background(), "ffprobe", path, 5_000, log); got != 4_000 {
		t.Fatalf("snapped start = %dms, want 4000ms", got)
	}
	// A target on the keyframe stays put; zero stays zero.
	if got := snapStartToVideoKeyframe(context.Background(), "ffprobe", path, 8_000, log); got != 8_000 {
		t.Fatalf("snapped start = %dms, want 8000ms", got)
	}
	if got := snapStartToVideoKeyframe(context.Background(), "ffprobe", path, 0, log); got != 0 {
		t.Fatalf("snapped start = %dms, want 0", got)
	}
	// A broken probe degrades to the raw target instead of blocking playback.
	if got := snapStartToVideoKeyframe(context.Background(), "ffprobe", filepath.Join(t.TempDir(), "missing.mkv"), 5_000, log); got != 5_000 {
		t.Fatalf("probe failure should fall back to target, got %dms", got)
	}
}

func TestParseStartQuery(t *testing.T) {
	if got := parseStartQuery("", 100_000); got != 0 {
		t.Fatalf("empty query = %d, want 0", got)
	}
	if got := parseStartQuery("61500", 100_000); got != 61500 {
		t.Fatalf("query = %d, want 61500", got)
	}
	if got := parseStartQuery("999999", 100_000); got != 0 {
		t.Fatalf("beyond duration = %d, want 0", got)
	}
	if got := parseStartQuery("abc", 100_000); got != 0 {
		t.Fatalf("non-numeric = %d, want 0", got)
	}
	if got := parseStartQuery("-5", 100_000); got != 0 {
		t.Fatalf("negative = %d, want 0", got)
	}
}
