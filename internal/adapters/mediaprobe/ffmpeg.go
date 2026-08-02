package mediaprobe

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

type Adapter struct {
	settings *config.Store
	slots    chan struct{}
}

func New(settings *config.Store) *Adapter {
	return &Adapter{settings: settings, slots: make(chan struct{}, 1)}
}

func (a *Adapter) ProbeSubtitles(ctx context.Context, path string) ([]domain.MediaSubtitleTrack, error) {
	if err := a.acquire(ctx); err != nil {
		return nil, err
	}
	defer a.release()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, a.settings.Get().FFprobePath, "-v", "error", "-select_streams", "s", "-show_streams", "-of", "json", path).Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe subtitle streams: %w", err)
	}
	var payload struct {
		Streams []struct {
			Index       int               `json:"index"`
			Codec       string            `json:"codec_name"`
			Tags        map[string]string `json:"tags"`
			Disposition map[string]int    `json:"disposition"`
		} `json:"streams"`
	}
	if err = json.Unmarshal(out, &payload); err != nil {
		return nil, fmt.Errorf("decode ffprobe output: %w", err)
	}
	now := time.Now().UTC()
	tracks := make([]domain.MediaSubtitleTrack, 0, len(payload.Streams))
	for _, stream := range payload.Streams {
		tracks = append(tracks, domain.MediaSubtitleTrack{Index: stream.Index, Language: stream.Tags["language"], Title: stream.Tags["title"], Codec: stream.Codec, Default: stream.Disposition["default"] == 1, Forced: stream.Disposition["forced"] == 1, HearingImpaired: stream.Disposition["hearing_impaired"] == 1, ProbedAt: now})
	}
	return tracks, nil
}

func (a *Adapter) ExtractSubtitle(ctx context.Context, path string, index int, target string) error {
	if err := a.acquire(ctx); err != nil {
		return err
	}
	defer a.release()
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, a.settings.Get().FFmpegPath, "-v", "error", "-nostdin", "-i", path, "-map", "0:"+strconv.Itoa(index), "-f", "webvtt", "-y", target).CombinedOutput()
	if err != nil {
		if len(output) > 2048 {
			output = output[len(output)-2048:]
		}
		return fmt.Errorf("extract embedded subtitle: %w: %s", err, string(output))
	}
	return nil
}
func (a *Adapter) acquire(ctx context.Context) error {
	select {
	case a.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (a *Adapter) release() { <-a.slots }
