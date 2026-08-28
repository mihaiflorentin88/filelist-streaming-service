import { defineConfig } from 'vitest/config';

// The web client tests run in happy-dom: the decode-fallback boundary tests
// render the real player wiring (component effects, video element state) and
// drive it through the injected AudioContext/Worker fakes.
export default defineConfig({ test: { environment: 'happy-dom', include: ['*.test.ts', '*.test.tsx'] } });
