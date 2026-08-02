import {defineConfig} from 'vite';import preact from '@preact/preset-vite';export default defineConfig({plugins:[preact()],build:{outDir:'../internal/adapters/httpapi/static',emptyOutDir:false}})
