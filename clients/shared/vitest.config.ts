import {defineConfig} from 'vitest/config';

// Pure client logic lives next to src/index.ts and runs under vitest (mirroring
// the TV client). The legacy node:test suite under test/ stays owned by the
// root `test:clients` script and is deliberately excluded here.
export default defineConfig({test:{include:['src/**/*.test.ts']}});
