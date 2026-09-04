package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/composition"
	"golang.org/x/term"
)

func main() {
	log, closeLog := newLogger(os.Stdout, term.IsTerminal(int(os.Stdout.Fd())), filepath.Join("data", "logs", "server.log"))
	defer closeLog()
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
