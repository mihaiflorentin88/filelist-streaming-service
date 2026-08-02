package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/composition"
)

func main() {
	output := io.Writer(os.Stdout)
	logPath := filepath.Join("data", "logs", "server.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o750); err == nil {
		if file, openErr := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640); openErr == nil {
			defer file.Close()
			output = io.MultiWriter(os.Stdout, file)
		}
	}
	log := slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{Level: slog.LevelInfo}))
	app, err := composition.New(log)
	if err != nil {
		log.Error("startup failed", "error", err)
		os.Exit(1)
	}
	defer app.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := app.Server.Shutdown(shutdownCtx); err != nil {
			log.Error("graceful shutdown failed", "error", err)
		}
	}()

	log.Info("server listening", "address", app.ListenAddress, "version", composition.Version, "settingsFile", app.Settings.Path())
	if err := app.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
