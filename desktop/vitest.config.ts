import { defineConfig } from 'vitest/config';

// Desktop shell tests run in happy-dom like the web client's; the Wails
// event API and the shared API module are mocked at module level.
export default defineConfig({ test: { environment: 'happy-dom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] } });
