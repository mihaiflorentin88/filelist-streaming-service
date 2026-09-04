import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedServerState } from '../lib/state';
import { DownloadsPage } from './DownloadsPage';

// The shared API is stubbed at the module boundary so the poll loop runs
// without a server; the Wails event API stays silent (the hook keeps its
// seed) and each test seeds the lifecycle state it needs.
const fakeApi = vi.hoisted(() => ({
  downloads: vi.fn(),
  deleteDownload: vi.fn(),
  call: vi.fn(),
}));

vi.mock('@filelist/web/shared-api', () => ({
  configureSharedApi: () => { },
  sharedApi: () => fakeApi,
}));

vi.mock('@wailsio/runtime', () => ({
  Events: { On: () => () => { } },
}));

const downloading = {
  id: 'd1', releaseId: 'r1', engineId: 'native:abc123', fileIndex: 0,
  filePath: 'Silo.S01E01.1080p.mkv', mimeType: 'video/x-matroska',
  sizeBytes: 4879437296, state: 'downloading', progress: 0.42, playbackMode: 'progressive',
  downloadedBytes: 2049363664, speedBytesPerSecond: 5242880, etaSeconds: 540, peers: 12, seeds: 3,
  leased: false, error: '', streamUrl: '/api/v1/downloads/d1/stream',
};

const mountedHosts: HTMLElement[] = [];

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  mountedHosts.push(host);
  // Render inside act so the page's poll effect runs before assertions —
  // matching the web client's test convention.
  await act(async () => { render(<DownloadsPage />, host) });
  return host;
}

async function settle() {
  await act(async () => { });
  await act(async () => { });
}

beforeEach(() => {
  seedServerState({ state: 'stopped' });
  fakeApi.downloads.mockReset();
  fakeApi.downloads.mockResolvedValue({ items: [] });
});

afterEach(() => {
  for (const host of mountedHosts) { render(null, host); host.remove() }
  mountedHosts.length = 0;
  document.body.innerHTML = '';
});

describe('DownloadsPage gating', () => {
  it('renders the not-running empty state and never touches a dead server', async () => {
    const host = await mount();
    await settle();
    const empty = host.querySelector('.empty-state');
    expect(empty?.textContent).toContain('Server is stopped');
    expect(empty?.textContent).toContain('Start the server to see downloads.');
    expect(fakeApi.downloads).not.toHaveBeenCalled();
    expect(host.querySelector('[data-download-id]')).toBeNull();
  });

  it('mounts the shared Downloads view once the server reports running', async () => {
    seedServerState({ state: 'running' });
    fakeApi.downloads.mockResolvedValue({ items: [downloading] });
    const host = await mount();
    await settle();
    expect(fakeApi.downloads).toHaveBeenCalled();
    expect(host.querySelector('.empty-state')).toBeNull();
    expect(host.querySelector('[data-download-id="d1"]')).not.toBeNull();
  });
});
