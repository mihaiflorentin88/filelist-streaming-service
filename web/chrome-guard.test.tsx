import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Downloads } from './downloads';
import { Jobs } from './jobs';
import { Settings } from './settings';
import { configureSharedApi } from './shared-api';

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
