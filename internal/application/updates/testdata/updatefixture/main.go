// Command updatefixture stands in for the real installation binary in
// update transaction tests. Apply mode drives one installation transaction
// and exits; helper mode runs the updates helper; normal mode performs the
// readiness health acknowledgement and then idles like a serving
// installation.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/application/updates"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	// Apply mode: drive one staging/activation/handoff transaction, then
	// exit so the helper — which waits for this process — can take over.
	if os.Getenv("FIXTURE_APPLY") == "1" {
		if err := applyErr(); err != nil {
			writeNamed("FIXTURE_APPLY_RESULT", err.Error())
			os.Exit(1)
		}
		writeNamed("FIXTURE_APPLY_RESULT", "")
		return
	}

	// Helper mode: the updates helper transaction. The outcome is written
	// to FIXTURE_RESULT for test assertions. Normal installations never
	// touch that file: they only serve.
	handled, err := updates.RunUpdateHelper(ctx)
	if handled {
		writeResult(handled, err)
		if err != nil {
			os.Exit(1)
		}
		return
	}
	serve()
}

// applyErr runs the full transaction described by the FIXTURE_* environment,
// mirroring what the installing process does before exiting.
func applyErr() error {
	installDir := os.Getenv("FIXTURE_INSTALL_DIR")
	kind := updates.PayloadFile
	if os.Getenv("FIXTURE_KIND") == "bundle" {
		kind = updates.PayloadBundle
	}
	archive, err := os.ReadFile(os.Getenv("FIXTURE_ASSET_FILE"))
	if err != nil {
		return fmt.Errorf("read staged asset: %w", err)
	}
	sel := updates.Selection{
		Version:   os.Getenv("FIXTURE_ASSET_VERSION"),
		AssetName: os.Getenv("FIXTURE_ASSET_NAME"),
		SHA256:    os.Getenv("FIXTURE_ASSET_SHA"),
	}
	target := updates.Target{
		GOOS:   os.Getenv("FIXTURE_TARGET_GOOS"),
		GOARCH: os.Getenv("FIXTURE_TARGET_GOARCH"),
		Flavor: os.Getenv("FIXTURE_TARGET_FLAVOR"),
	}
	journal, err := updates.OpenJournal(installDir)
	if err != nil {
		return err
	}
	defer journal.Close()
	installer := updates.NewInstaller(journal, kind,
		os.Getenv("FIXTURE_LIVE_PATH"), os.Getenv("FIXTURE_BUNDLE_PATH"),
		time.Duration(envMillis("FIXTURE_HEALTH_TIMEOUT_MS"))*time.Millisecond)
	staged, err := updates.StageArchive(installDir, sel, newByteReader(archive), updates.DefaultLimits())
	if err != nil {
		return err
	}
	payload, err := staged.Extract(installDir, target, updates.DefaultLimits())
	if err != nil {
		return err
	}
	op, err := installer.Prepare(payload, sel, target, staged.Path)
	if err != nil {
		return err
	}
	op, err = installer.Activate(op, payload)
	if err != nil {
		return err
	}
	// The helper and the launched installation must not re-enter apply mode
	// when they run this same binary.
	os.Unsetenv("FIXTURE_APPLY")
	return installer.Handoff(op, payload)
}

// serve emulates a normal installation: readiness marker, optional startup
// delay, optional early death, health acknowledgement against the journal,
// then idle until signalled.
func serve() {
	if os.Getenv("FIXTURE_EXIT_IMMEDIATELY") == "1" {
		if path := os.Getenv("FIXTURE_EXIT_FILE"); path != "" {
			os.WriteFile(path, []byte(fmt.Sprintf("exited %d", os.Getpid())), 0o644)
		}
		os.Exit(3)
	}
	marker := os.Getenv("FIXTURE_CHILD_MARKER")
	if marker != "" {
		os.WriteFile(marker, []byte(fmt.Sprintf("ready %d", os.Getpid())), 0o644)
	}
	if delay := envMillis("FIXTURE_ACK_DELAY_MS"); delay > 0 {
		time.Sleep(time.Duration(delay) * time.Millisecond)
	}
	ackDir := os.Getenv("FIXTURE_ACK_DIR")
	if ackDir == "" {
		idle()
		return
	}
	op, found, err := updates.LoadOperation(ackDir)
	if err != nil || !found {
		noteAckError(marker, fmt.Sprintf("load operation: %v", err))
		idle()
		return
	}
	// The running installation acknowledges without updater ownership.
	if err := updates.AcknowledgeOperation(ackDir, op.ID, os.Getenv("FIXTURE_ACK_VERSION")); err != nil {
		noteAckError(marker, fmt.Sprintf("acknowledge: %v", err))
		idle()
		return
	}
	if marker != "" {
		os.WriteFile(marker, []byte(fmt.Sprintf("acked %d", os.Getpid())), 0o644)
	}
	idle()
}

func idle() {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case <-stop:
	case <-time.After(9 * time.Minute):
	}
}

func noteAckError(marker, text string) {
	if marker != "" {
		os.WriteFile(marker, []byte("ack-error: "+text), 0o644)
		return
	}
	fmt.Fprintln(os.Stderr, text)
}

func writeResult(handled bool, err error) {
	path := os.Getenv("FIXTURE_RESULT")
	if path == "" {
		return
	}
	payload := struct {
		Handled bool   `json:"handled"`
		Error   string `json:"error,omitempty"`
	}{Handled: handled}
	if err != nil {
		payload.Error = err.Error()
	}
	data, mErr := json.Marshal(payload)
	if mErr == nil {
		os.WriteFile(path, data, 0o644)
	}
}

func writeNamed(env, text string) {
	path := os.Getenv(env)
	if path == "" {
		return
	}
	os.WriteFile(path, []byte(text), 0o644)
}

func envMillis(name string) int64 {
	text := os.Getenv(name)
	if text == "" {
		return 0
	}
	var value int64
	fmt.Sscanf(text, "%d", &value)
	return value
}

type sliceReader struct {
	data []byte
	pos  int
}

func newByteReader(data []byte) *sliceReader { return &sliceReader{data: data} }

func (s *sliceReader) Read(p []byte) (int, error) {
	if s.pos >= len(s.data) {
		return 0, io.EOF
	}
	n := copy(p, s.data[s.pos:])
	s.pos += n
	return n, nil
}
