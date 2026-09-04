// Package datadir resolves the application data directory and relocates it.
// Resolution order (spec: Data directory): --data-dir flag, then the
// data.location pointer file next to the executable, then data/ next to the
// executable.
package datadir

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const pointerName = "data.location"

// Relocate moves the data directory from → to and records the new location.
// The caller must have stopped the server first.
func Relocate(exePath, from, to string) error {
	absTo, err := filepath.Abs(to)
	if err != nil {
		return err
	}
	if absTo == from {
		return fmt.Errorf("new data location is the current location")
	}
	if entries, err := os.ReadDir(absTo); err == nil && len(entries) > 0 {
		return fmt.Errorf("target %s is not empty", absTo)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := moveTree(from, absTo); err != nil {
		return err
	}
	return SetPointer(exePath, absTo)
}

func moveTree(from, to string) error {
	// Same volume: rename is atomic and instant.
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	// Cross volume: copy, verify each file by SHA-256, delete only after all
	// copies verified; on any error leave the source untouched.
	if err := copyTree(from, to); err != nil {
		return err
	}
	return os.RemoveAll(from)
}

func copyTree(from, to string) error {
	return filepath.WalkDir(from, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		target := filepath.Join(to, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o750)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if err := copyVerified(path, target, info.Mode()); err != nil {
			return err
		}
		return os.Chmod(target, info.Mode())
	})
}

func copyVerified(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, h), in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	// Verify the copy: re-open dst and compare its digest against the
	// source digest captured during the write.
	vf, err := os.Open(dst)
	if err != nil {
		os.Remove(dst)
		return err
	}
	hDst := sha256.New()
	_, err = io.Copy(hDst, vf)
	vf.Close()
	if err != nil {
		os.Remove(dst)
		return err
	}
	if !bytesEqual(h.Sum(nil), hDst.Sum(nil)) {
		os.Remove(dst)
		return fmt.Errorf("verification failed copying %s", src)
	}
	return nil
}

func bytesEqual(a, b []byte) bool {
	return hex.EncodeToString(a) == hex.EncodeToString(b)
}

func Resolve(flagDir, exePath string) (string, string, error) {
	if strings.TrimSpace(flagDir) != "" {
		abs, err := filepath.Abs(flagDir)
		return abs, "flag", err
	}
	if p := readPointer(exePath); p != "" {
		return p, "pointer", nil
	}
	return filepath.Join(filepath.Dir(exePath), "data"), "default", nil
}

func PointerPath(exePath string) string {
	return filepath.Join(filepath.Dir(exePath), pointerName)
}

func readPointer(exePath string) string {
	b, err := os.ReadFile(PointerPath(exePath))
	if err != nil {
		return ""
	}
	p := strings.TrimSpace(string(b))
	if !filepath.IsAbs(p) {
		return ""
	}
	return p
}

func SetPointer(exePath, dir string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	tmp := PointerPath(exePath) + ".tmp"
	if err := os.WriteFile(tmp, []byte(abs+"\n"), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, PointerPath(exePath))
}

func ClearPointer(exePath string) error {
	err := os.Remove(PointerPath(exePath))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
