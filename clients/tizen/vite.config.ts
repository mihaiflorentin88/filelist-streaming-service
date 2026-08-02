import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig, Plugin} from 'vite';
import preact from '@preact/preset-vite';

const root = dirname(fileURLToPath(import.meta.url));

function packageStaticFiles(): Plugin {
  return {
    name: 'package-tizen-static-files',
    generateBundle() {
      for (const name of ['index.html', 'startup.js']) {
        this.emitFile({type: 'asset', fileName: name, source: readFileSync(resolve(root, name))});
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [preact(), packageStaticFiles()],
  build: {
    target: 'es2017',
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(root, 'src/main.tsx'),
      name: 'FileListTV',
      formats: ['iife'],
      fileName: () => 'app.js',
      cssFileName: 'app',
    },
  },
});
