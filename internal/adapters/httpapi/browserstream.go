package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// keyframeSnapWindow bounds how far back a keyframe may sit from the seek
// target before the snap gives up; WEB-DL GOPs stay well inside it.
const keyframeSnapWindow = 15

// snapStartToVideoKeyframe moves a seek target back to the last video
// keyframe at or before it. Stream-copied video can only start on a
// keyframe, while the re-encoded audio starts exactly at the target, so an
// unsnapped seek leaves the audio leading the picture by up to one GOP
// (measured: 0.2-1.7s on this library). Aligning both streams on the
// keyframe removes the offset by construction. Any probe failure degrades
// to the raw target: playback must never be blocked by the snap.
func snapStartToVideoKeyframe(ctx context.Context, ffprobePath, input string, targetMs int64, log *slog.Logger) int64 {
	if targetMs <= 0 {
		return 0
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	from := targetMs/1000 - int64(keyframeSnapWindow)
	if from < 0 {
		from = 0
	}
	interval := fmt.Sprintf("%d%%%d", from, targetMs/1000+1)
	out, err := exec.CommandContext(
		probeCtx, ffprobePath,
		"-v", "error",
		"-read_intervals", interval,
		"-select_streams", "v:0",
		"-show_entries", "packet=pts_time,flags",
		"-of", "csv=p=0",
		input,
	).Output()
	if err != nil {
		log.Warn("keyframe snap probe failed; using raw seek target", "targetMs", targetMs, "error", err)
		return targetMs
	}
	best := -1.0
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Split(strings.TrimSpace(line), ",")
		if len(fields) < 2 || !strings.Contains(fields[1], "K") {
			continue
		}
		pts, err := strconv.ParseFloat(fields[0], 64)
		if err != nil || pts < 0 || pts > float64(targetMs)/1000 {
			continue
		}
		if pts > best {
			best = pts
		}
	}
	if best < 0 {
		return targetMs
	}
	return int64(best * 1000)
}

// parseStartQuery validates the raw startMs query value against the media
// duration and returns the target in milliseconds (0 when absent). The
// compatibility route snaps the result to a keyframe before seeking.
func parseStartQuery(requestedStart string, durationMS int64) int64 {
	if requestedStart == "" {
		return 0
	}
	value, err := strconv.ParseInt(requestedStart, 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	if durationMS > 0 && value >= durationMS {
		return 0
	}
	return value
}
