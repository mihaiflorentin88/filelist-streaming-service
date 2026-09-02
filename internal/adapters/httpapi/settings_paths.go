package httpapi

import (
	"fmt"
	"os"
)

// ensureNativePathsWritable prepares the directories the native torrent engine
// writes to at startup: it creates them when missing and proves they accept
// writes. It runs while saving settings so a bad path fails the save with a
// visible error instead of crash-looping the service on the next restart.
// The check runs inside the same process (and therefore the same systemd
// sandbox) as the engine, so it fails exactly when startup would.
func ensureNativePathsWritable(downloadEngine, downloadRoot, sessionDir string) error {
	if downloadEngine != "native" {
		return nil
	}
	dirs := []struct{ label, path string }{
		{"download root", downloadRoot},
		{"torrent session directory", sessionDir},
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir.path, 0o755); err != nil {
			return fmt.Errorf("cannot create %s %s: %w", dir.label, dir.path, err)
		}
		probe, err := os.CreateTemp(dir.path, ".write-probe-*")
		if err != nil {
			return fmt.Errorf("%s %s is not writable: %w", dir.label, dir.path, err)
		}
		name := probe.Name()
		_ = probe.Close()
		_ = os.Remove(name)
	}
	return nil
}
