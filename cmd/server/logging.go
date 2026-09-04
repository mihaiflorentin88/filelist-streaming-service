package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/term"
)

const (
	colorReset  = "\033[0m"
	colorBlue   = "\033[34m"
	colorYellow = "\033[33m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
)

// NewColorHandler renders human-readable, colorized lines on a terminal.
// The file handler stays plain JSON; this one is console-only.
func NewColorHandler(w io.Writer, opts *slog.HandlerOptions) slog.Handler {
	if opts == nil {
		opts = &slog.HandlerOptions{}
	}
	return &colorHandler{w: w, opts: *opts}
}

type colorHandler struct {
	w    io.Writer
	opts slog.HandlerOptions
}

func (h *colorHandler) Enabled(_ context.Context, level slog.Level) bool {
	minLevel := h.opts.Level
	if minLevel == nil {
		return true
	}
	return level >= minLevel.Level()
}

func (h *colorHandler) Handle(_ context.Context, r slog.Record) error {
	t := r.Time
	if t.IsZero() {
		t = time.Now()
	}
	ts := t.Format("2006-01-02 15:04:05")

	var levelColor string
	switch r.Level {
	case slog.LevelInfo:
		levelColor = "🔵 " + colorBlue
	case slog.LevelDebug:
		levelColor = "🟡 " + colorYellow
	case slog.LevelWarn:
		levelColor = "🟡 " + colorYellow
	case slog.LevelError:
		levelColor = "🔴 " + colorRed
	default:
		levelColor = "⚪ " + colorReset
	}
	simpleLevelColor := strings.Split(levelColor, " ")[1]

	var messages []string
	r.Attrs(func(a slog.Attr) bool {
		messages = append(messages, fmt.Sprintf("%s%s%s: %s%v%s", colorYellow, a.Key, colorReset, simpleLevelColor, a.Value, colorReset))
		return true
	})
	line := fmt.Sprintf("%s | %s%s%s -> %s%s%s", ts, levelColor, r.Level.String(), colorReset, colorGreen, r.Message, colorReset)
	if len(messages) > 0 {
		line += " <- " + strings.Join(messages, " | ")
	}
	_, err := fmt.Fprintln(h.w, line)
	return err
}

func (h *colorHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *colorHandler) WithGroup(string) slog.Handler      { return h }

// teeHandler fans every record out to all child handlers: colored console
// plus the JSON file.
type teeHandler struct {
	handlers []slog.Handler
}

func (t *teeHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range t.handlers {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (t *teeHandler) Handle(ctx context.Context, r slog.Record) error {
	for _, handler := range t.handlers {
		if err := handler.Handle(ctx, r.Clone()); err != nil {
			return err
		}
	}
	return nil
}

func (t *teeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, 0, len(t.handlers))
	for _, handler := range t.handlers {
		next = append(next, handler.WithAttrs(attrs))
	}
	return &teeHandler{handlers: next}
}

func (t *teeHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, 0, len(t.handlers))
	for _, handler := range t.handlers {
		next = append(next, handler.WithGroup(name))
	}
	return &teeHandler{handlers: next}
}

// isTerminal reports whether the console stream is an interactive terminal.
func isTerminal(f *os.File) bool {
	return term.IsTerminal(int(f.Fd()))
}

// logFilePath returns the JSON log file path under the resolved data
// directory.
func logFilePath(dataDir string) string {
	return filepath.Join(dataDir, "logs", "server.log")
}

// newLogger builds the process logger: colored human-readable lines on an
// interactive terminal, plain JSON otherwise, and an unchanged JSON stream
// in <data dir>/logs/server.log for machine readers.
func newLogger(console io.Writer, colored bool, logPath string) (*slog.Logger, func()) {
	opts := &slog.HandlerOptions{Level: slog.LevelInfo}
	var consoleHandler slog.Handler = slog.NewJSONHandler(console, opts)
	if colored {
		consoleHandler = NewColorHandler(console, opts)
	}
	handlers := []slog.Handler{consoleHandler}
	closeLog := func() {}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o750); err == nil {
		if file, openErr := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640); openErr == nil {
			handlers = append(handlers, slog.NewJSONHandler(file, opts))
			closeLog = func() { _ = file.Close() }
		}
	}
	return slog.New(&teeHandler{handlers: handlers}), closeLog
}
