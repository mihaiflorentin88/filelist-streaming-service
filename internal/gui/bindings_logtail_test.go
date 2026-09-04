package gui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeServerLog creates the GUI session's log file layout under dir
// (<data dir>/logs/server.jsonl) with the given content.
func writeServerLog(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "logs", "server.jsonl"), []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
}

func appendServerLog(t *testing.T, dir, content string) {
	t.Helper()
	f, err := os.OpenFile(filepath.Join(dir, "logs", "server.jsonl"), os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

func testBindingsWithDir(t *testing.T, dir string) *Bindings {
	return &Bindings{settings: testStore(t), dataDir: dir, dataDirSource: "default"}
}

func TestReadLogsReturnsOnlyAppendsAfterOffset(t *testing.T) {
	dir := t.TempDir()
	writeServerLog(t, dir, `{"time":"t1","level":"INFO","msg":"one"}`+"\n"+`{"time":"t2","level":"INFO","msg":"two"}`+"\n")
	b := testBindingsWithDir(t, dir)

	tail, err := b.ReadLogs(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Lines) != 2 || tail.Lines[0] != `{"time":"t1","level":"INFO","msg":"one"}` {
		t.Fatalf("first read = %v", tail.Lines)
	}
	wantOffset := int64(len(`{"time":"t1","level":"INFO","msg":"one"}` + "\n" + `{"time":"t2","level":"INFO","msg":"two"}` + "\n"))
	if tail.NextOffset != wantOffset || tail.Size != wantOffset {
		t.Fatalf("nextOffset/size = %d/%d, want %d", tail.NextOffset, tail.Size, wantOffset)
	}

	appendServerLog(t, dir, `{"time":"t3","level":"WARN","msg":"three"}`+"\n")
	tail, err = b.ReadLogs(tail.NextOffset)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Lines) != 1 || tail.Lines[0] != `{"time":"t3","level":"WARN","msg":"three"}` {
		t.Fatalf("incremental read = %v, want only the new line", tail.Lines)
	}
	if tail.NextOffset != wantOffset+int64(len(`{"time":"t3","level":"WARN","msg":"three"}`+"\n")) {
		t.Fatalf("nextOffset = %d", tail.NextOffset)
	}
}

func TestReadLogsResetsAfterTruncation(t *testing.T) {
	dir := t.TempDir()
	writeServerLog(t, dir, strings.Repeat("old line\n", 10))
	b := testBindingsWithDir(t, dir)

	tail, err := b.ReadLogs(0)
	if err != nil {
		t.Fatal(err)
	}

	// Rotation/truncation: the file is rewritten shorter than the caller's
	// offset — the read must restart from the beginning, not fail.
	writeServerLog(t, dir, "fresh\n")
	tail, err = b.ReadLogs(tail.NextOffset)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Lines) != 1 || tail.Lines[0] != "fresh" {
		t.Fatalf("post-truncation read = %v, want the whole new log", tail.Lines)
	}
	if tail.NextOffset != 6 {
		t.Fatalf("nextOffset = %d, want 6", tail.NextOffset)
	}
}

func TestReadLogsCapsTheWindowAtALineBoundary(t *testing.T) {
	dir := t.TempDir()
	huge := strings.Repeat("x", 300000)
	writeServerLog(t, dir, huge+"\nline-b\nline-c\n")
	b := testBindingsWithDir(t, dir)

	tail, err := b.ReadLogs(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Lines) != 2 || tail.Lines[0] != "line-b" || tail.Lines[1] != "line-c" {
		t.Fatalf("capped read = %q, want the complete tail lines only", tail.Lines)
	}
	if len(strings.Join(tail.Lines, "\n")) > logTailCap {
		t.Fatalf("returned %d bytes, over the cap", len(strings.Join(tail.Lines, "\n")))
	}
	if tail.NextOffset != tail.Size {
		t.Fatalf("nextOffset = %d, want %d (all complete lines served)", tail.NextOffset, tail.Size)
	}
}

func TestReadLogsHoldsBackPartialLastLine(t *testing.T) {
	dir := t.TempDir()
	writeServerLog(t, dir, `{"msg":"half`)
	b := testBindingsWithDir(t, dir)

	tail, err := b.ReadLogs(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Lines) != 0 || tail.NextOffset != 0 {
		t.Fatalf("partial line read = %v next=%d, want nothing held-back yet", tail.Lines, tail.NextOffset)
	}

	appendServerLog(t, dir, ` whole"}`+"\n")
	tail, err = b.ReadLogs(tail.NextOffset)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Lines) != 1 || tail.Lines[0] != `{"msg":"half whole"}` {
		t.Fatalf("completed line read = %v", tail.Lines)
	}
}

func TestReadLogsMissingFileAndUnresolvedDir(t *testing.T) {
	b := testBindingsWithDir(t, t.TempDir())
	tail, err := b.ReadLogs(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Lines) != 0 || tail.NextOffset != 0 || tail.Size != 0 {
		t.Fatalf("missing log = %+v, want an empty tail", tail)
	}

	// dataDirInfo falls back to lazy resolution; only a failing exe path
	// (its seam) leaves the data dir unresolvable.
	unresolved := &Bindings{settings: testStore(t), exePathFn: func() (string, error) { return "", errors.New("no exe") }}
	if _, err := unresolved.ReadLogs(0); err == nil {
		t.Fatal("ReadLogs without a resolvable data dir must fail")
	}
}
