package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestColorHandlerRendersANSIColorsPerLevel(t *testing.T) {
	var out bytes.Buffer
	handler := NewColorHandler(&out, &slog.HandlerOptions{Level: slog.LevelInfo})

	record := slog.NewRecord(time.Time{}, slog.LevelError, "startup failed", 0)
	record.AddAttrs(slog.String("error", "boom"))
	if err := handler.Handle(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	line := out.String()
	for _, want := range []string{"startup failed", "error", "boom", "\x1b[31m", "\x1b[0m", "🔴"} {
		if !strings.Contains(line, want) {
			t.Fatalf("colored line missing %q: %q", want, line)
		}
	}

	out.Reset()
	infoRecord := slog.NewRecord(time.Time{}, slog.LevelInfo, "server listening", 0)
	if err := handler.Handle(context.Background(), infoRecord); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "\x1b[34m") {
		t.Fatalf("info line missing blue color: %q", out.String())
	}
}

func TestColorHandlerRespectsLevel(t *testing.T) {
	var out bytes.Buffer
	handler := NewColorHandler(&out, &slog.HandlerOptions{Level: slog.LevelWarn})

	if handler.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("info should be disabled at warn level")
	}
	if !handler.Enabled(context.Background(), slog.LevelError) {
		t.Fatal("error should be enabled at warn level")
	}
}

type captureHandler struct {
	buf     *bytes.Buffer
	records int
}

func (c *captureHandler) Enabled(context.Context, slog.Level) bool { return true }
func (c *captureHandler) Handle(_ context.Context, r slog.Record) error {
	c.records++
	return json.NewEncoder(c.buf).Encode(map[string]any{"msg": r.Message, "level": r.Level.String()})
}
func (c *captureHandler) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *captureHandler) WithGroup(string) slog.Handler      { return c }

func TestTeeFanOutWritesEveryHandler(t *testing.T) {
	first, second := &captureHandler{buf: &bytes.Buffer{}}, &captureHandler{buf: &bytes.Buffer{}}
	tee := &teeHandler{handlers: []slog.Handler{first, second}}

	if !tee.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("tee should be enabled when any child is enabled")
	}
	record := slog.NewRecord(time.Time{}, slog.LevelWarn, "fanned out", 0)
	if err := tee.Handle(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if first.records != 1 || second.records != 1 {
		t.Fatalf("tee did not fan out: first=%d second=%d", first.records, second.records)
	}
}

func TestNewLoggerKeepsFileJSONAndColorsConsoleOnly(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "logs", "server.log")

	var console bytes.Buffer
	logger, closeLog := newLogger(&console, true, logPath)
	logger.Error("startup failed", "error", "read-only file system")
	closeLog()

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "startup failed") {
		t.Fatalf("file missing the log record: %s", data)
	}
	if strings.Contains(string(data), "\x1b[") {
		t.Fatalf("file contains ANSI colors: %s", data)
	}
	trimmed := bytes.TrimRight(data, "\n")
	var entry map[string]any
	if err := json.Unmarshal(trimmed, &entry); err != nil {
		t.Fatalf("file line is not JSON: %v (%s)", err, data)
	}
	if entry["msg"] != "startup failed" {
		t.Fatalf("unexpected file entry: %#v", entry)
	}

	if !strings.Contains(console.String(), "\x1b[31m") {
		t.Fatalf("colored console missing ANSI for error: %q", console.String())
	}
}

func TestNewLoggerWithoutTTYLogsPlainJSON(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "logs", "server.log")

	var console bytes.Buffer
	logger, closeLog := newLogger(&console, false, logPath)
	logger.Info("server listening", "address", ":8097")
	closeLog()

	if strings.Contains(console.String(), "\x1b[") {
		t.Fatalf("non-TTY console must stay plain: %q", console.String())
	}
	if !strings.Contains(console.String(), `"msg":"server listening"`) {
		t.Fatalf("non-TTY console should log JSON: %q", console.String())
	}
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"msg":"server listening"`) {
		t.Fatalf("file missing the record: %s", data)
	}
}
