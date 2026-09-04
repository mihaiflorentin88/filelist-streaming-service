import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheCoverage, Settings } from './settings';
import { configureSharedApi } from './shared-api';
import { Downloads } from './downloads';
import { Jobs } from './jobs';

// Spec: Reuse boundary — shared components never render webapp shell (no
// nav, header, footer, or sidebar). Jobs' own pagination nav is part of the
// view, not shell chrome, so it is the one excluded nav. The shared API
// points at a closed port so self-fetching components (Jobs) fail quietly
// into their onError paths; the guard asserts structure, not data.
configureSharedApi('http://127.0.0.1:1');

const mountedHosts: HTMLElement[] = [];

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  mountedHosts.push(host);
  render(ui, host);
  return host;
}

afterEach(() => {
  for (const host of mountedHosts) { render(null, host); host.remove() }
  mountedHosts.length = 0;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe.each([
  ['Downloads', <Downloads items={[]} onRefresh={() => { }} onPlay={() => { }} onRemove={async () => { }} onAction={async () => { }} />],
  ['Jobs', <Jobs onError={() => { }} onOpenDetail={() => { }} onCloseDetail={() => { }} />],
  ['Settings', <Settings value={{}} fields={[]} onSaved={() => { }} onError={() => { }} />],
])('%s renders no webapp chrome', (_name, ui) => {
  it('has no nav/sidebar/header/footer', () => {
    expect(mount(ui).querySelectorAll('nav:not(.pagination), header, footer, .sidebar')).toHaveLength(0);
  });
});

// Regression: shared components must resolve the API client at call time.
// settings.tsx used to capture `sharedApi()` in a module-scope const, which
// ESM evaluation freezes before the desktop entry's configureSharedApi call
// lands. CacheCoverage fetches on mount, so the outgoing URL exposes which
// client actually ran.
describe('shared API origin resolution', () => {
  it('resolves the client at call time, not module evaluation', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', (url: string | URL | Request) => { requested.push(String(url)); return { ok: true, status: 204, json: async () => ({}) } as Response });
    configureSharedApi('http://127.0.0.1:9911');
    await act(async () => { mount(<CacheCoverage />) });
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    });
    expect(requested[0]).toBe('http://127.0.0.1:9911/api/v1/catalog/status');
  });
});
