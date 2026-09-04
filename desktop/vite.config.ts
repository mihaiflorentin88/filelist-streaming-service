import { defineConfig } from 'vite'; import preact from '@preact/preset-vite';
// Assets embed into the Go binary: outDir is the GUI-only static dir. The
// build wipes it (emptyOutDir) and the package's postbuild script restores
// the committed .gitkeep so the go:embed all:static pattern in
// internal/gui/assets.go still matches on a fresh clone. Dev proxies /api
// to the standalone server the supervisor will manage on the same port.
export default defineConfig({ plugins: [preact()], build: { outDir: '../internal/gui/static', emptyOutDir: true }, server: { proxy: { '/api': 'http://127.0.0.1:8097' } } })
