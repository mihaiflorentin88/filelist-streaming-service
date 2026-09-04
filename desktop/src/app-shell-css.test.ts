import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The desktop shell chrome (sidebar, header, status pill, state dots) is
// styled by shell.css alone; dropping its import leaves the app unstyled
// (regression shipped in e095a22 and caught in review). Vite strips CSS
// imports from the module graph tests see, so the sturdiest guard is the
// source itself: assert the import line textually.
describe('App shell stylesheet', () => {
  it('imports shell.css', () => {
    // vitest runs from the workspace root (desktop/), where the source lives.
    const source = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(source).toContain(`import './shell.css';`);
  });
});
