import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { seedServerState, useServerState } from './state';

// The Wails runtime is mocked at the module boundary: the fake records
// 'server:state' subscriptions so tests can emit lifecycle events the way
// the Task 6 runner will.
const fakeEvents = vi.hoisted(() => {
  const subscribers = new Map<string, Array<(event: { data: unknown }) => void>>();
  return {
    subscribers,
    emit(name: string, data: unknown) {
      for (const handler of subscribers.get(name) ?? []) handler({ data });
    },
    reset() { subscribers.clear() },
  };
});

vi.mock('@wailsio/runtime', () => ({
  Events: {
    On: (name: string, handler: (event: { data: unknown }) => void) => {
      const handlers = fakeEvents.subscribers.get(name) ?? [];
      handlers.push(handler);
      fakeEvents.subscribers.set(name, handlers);
      return () => { fakeEvents.subscribers.set(name, handlers.filter(item => item !== handler)) };
    },
  },
}));

// App mounts the downloads view by default; the shared API is stubbed so
// the poll loop stays inert while the pill and nav are under test.
vi.mock('@filelist/web/shared-api', () => ({
  configureSharedApi: () => { },
  sharedApi: () => ({ downloads: async () => ({ items: [] }) }),
}));

function StateProbe() {
  const server = useServerState();
  return <p>{server.state}{server.address ? ` · ${server.address}` : ''}</p>;
}

const mountedHosts: HTMLElement[] = [];

async function mount(ui: Parameters<typeof render>[0]): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  mountedHosts.push(host);
  // Render inside act so the hook's subscribe effect runs before tests
  // emit — matching the web client's test convention.
  await act(async () => { render(ui, host) });
  return host;
}

beforeEach(() => {
  seedServerState({ state: 'stopped' });
});

afterEach(() => {
  for (const host of mountedHosts) { render(null, host); host.remove() }
  mountedHosts.length = 0;
  document.body.innerHTML = '';
  fakeEvents.reset();
});

describe('useServerState', () => {
  it('seeds stopped before the runner emits anything', async () => {
    const host = await mount(<StateProbe />);
    expect(host.textContent).toBe('stopped');
  });

  it('updates on server:state events from the runner', async () => {
    const host = await mount(<StateProbe />);
    await act(async () => { fakeEvents.emit('server:state', { state: 'running', address: '127.0.0.1:8097' }) });
    expect(host.textContent).toBe('running · 127.0.0.1:8097');
    await act(async () => { fakeEvents.emit('server:state', { state: 'failed', error: 'boom' }) });
    expect(host.textContent).toBe('failed');
  });

  it('ignores payloads without a known state', async () => {
    const host = await mount(<StateProbe />);
    await act(async () => { fakeEvents.emit('server:state', { state: 'bogus' }) });
    expect(host.textContent).toBe('stopped');
  });

  it('initializes late mounts from the latest emitted state', async () => {
    const first = await mount(<StateProbe />);
    await act(async () => { fakeEvents.emit('server:state', { state: 'running', address: '127.0.0.1:8097' }) });
    expect(first.textContent).toBe('running · 127.0.0.1:8097');
    // A second component mounted after the emit (no new emit) must not
    // resurrect the boot seed — JobsPage gating depends on this.
    const second = await mount(<StateProbe />);
    expect(second.textContent).toBe('running · 127.0.0.1:8097');
  });
});

describe('shell chrome', () => {
  it('seeds the status pill from the boot state and tracks emits', async () => {
    seedServerState({ state: 'starting' });
    const host = await mount(<App />);
    const pill = host.querySelector('.pill');
    expect(pill?.className).toContain('pill-starting');
    expect(pill?.textContent).toBe('Starting');
    await act(async () => { fakeEvents.emit('server:state', { state: 'running', address: '127.0.0.1:8097' }) });
    expect(host.querySelector('.pill')?.textContent).toBe('Running · 127.0.0.1:8097');
    expect(host.querySelectorAll('.dot-running').length).toBeGreaterThanOrEqual(3);
  });

  it('carries exactly the shipped sections; Task 10 appended Server and Settings', async () => {
    const host = await mount(<App />);
    const labels = Array.from(host.querySelectorAll('.shell-nav button')).map(button => button.textContent?.trim());
    expect(labels).toEqual(['Downloads', 'Jobs', 'Server', 'Settings']);
  });
});
