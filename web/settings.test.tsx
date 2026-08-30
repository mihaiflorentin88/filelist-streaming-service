import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API, type HouseholdState } from '@filelist/shared';
import { App } from './src';

// App-seam tests for the redesigned Settings surface (spec #65, tickets
// #67-#70): the whole app mounts, the API is mocked at the class boundary,
// and the tests drive tabs, saves, and guards through the rendered DOM.
// Prior art: overlay-escape.test.tsx.

const settingsValue: Record<string, unknown> = {
 settingsPath: 'data/settings.json',
 fileListUrl: 'https://filelist.io', fileListUsername: 'user', fileListPasskey: '', fileListPasskeyConfigured: true,
 tmdbApiKey: '', tmdbApiKeyConfigured: true, metadataLanguage: 'en', metadataFallbackLanguage: 'en',
 qbittorrentUrl: 'http://localhost:8080', qbittorrentUsername: 'admin', qbittorrentPassword: '', qbittorrentPasswordConfigured: true,
 downloadRoot: '/data', allocationGb: 100, reserveGb: 5, evictionRules: 'oldest-completed',
 protectIncomplete: true, protectLeased: false, protectFavorites: true, protectNeverWatched: false,
 artworkCachePath: 'data/artwork', artworkCacheMaxBytes: 1073741824,
 initialBufferBytes: 4194304, readAheadBytes: 8388608, pieceWaitTimeoutSeconds: 30,
 subDLUrl: 'https://api.subdl.example', subDLApiKey: '', subDLApiKeyConfigured: true,
 preferredAudioLanguage: 'en', preferredSubtitleLanguage: 'en', fallbackSubtitleLanguage: 'ro',
 watchedThresholdPercent: 90, subtitleCachePath: 'data/subtitles', subtitleCacheMaxBytes: 536870912,
 ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg',
 instanceName: 'filelist', listenAddress: ':8097', databasePath: 'data/filelist.db',
 catalogMaxAgeHours: 24, maxConcurrentJobs: 10, titleRefreshTimeoutMinutes: 30, trustedCidrs: '192.168.50.0/24',
};

const schemaFields = [
 { key: 'databasePath', label: 'Database path', help: 'Where the catalog database lives.', tvVisible: false, sensitive: false, restartRequired: true },
 { key: 'listenAddress', label: 'Listen address', help: 'HTTP listen address.', tvVisible: false, sensitive: false, restartRequired: true, readOnly: true },
];

const catalogStatus = { observedReleases: 1200, discoverableReleases: 800, hiddenZeroSeeders: 400, fileListLatestWindowLimit: 1000 };

const syncJob = { id: 'job-1', kind: 'catalog_sync', state: 'queued', label: 'Fetch latest', dedupeKey: 'catalog:latest', progress: 0, attempt: 0, retryable: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

const putCalls: Array<{ body: Record<string, unknown> }> = [];

async function fakeCall(path: string, init?: RequestInit): Promise<unknown> {
 const method = init?.method || 'GET';
 if (path === '/settings' && method === 'GET') return settingsValue;
 if (path === '/settings/schema') return { items: schemaFields };
 if (path === '/catalog/status') return catalogStatus;
 if (path === '/settings' && method === 'PUT') {
  putCalls.push({ body: JSON.parse(String(init?.body)) });
  return settingsValue;
 }
 if (path.startsWith('/dependencies/') && path.endsWith('/test')) return { message: `${path} ok` };
 throw new Error(`unexpected API call ${method} ${path}`);
}

const emptyHousehold: HouseholdState = { favorites: [], continueWatching: [], recent: [], watched: [] };

class FakeEventSource { addEventListener() { } close() { } }

const mountedHosts: HTMLElement[] = [];

async function mountApp() {
 const host = document.createElement('div');
 document.body.appendChild(host);
 mountedHosts.push(host);
 await act(async () => { render(<App />, host) });
 await act(async () => { }); // flush the initial state/titles/facets loads
}

const sidebarButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar nav button')).find(button => button.textContent?.includes(label))!;

async function openSettings() {
 await mountApp();
 await act(async () => { sidebarButton('Settings').click() });
 await settle();
}

const settingsTabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-tabs button'));
async function settle() {
 for (let i = 0; i < 5; i++) {
  await act(async () => {
   const { promise, resolve } = Promise.withResolvers<void>();
   setTimeout(resolve, 0);
   await promise;
  });
 }
}
const panel = () => document.querySelector('.settings-panel')!;

const fieldInput = (label: string) => Array.from(document.querySelectorAll('.settings-panel label')).find(item => item.querySelector('span')?.textContent?.startsWith(label))!.querySelector('input')!;

function setFieldInput(label: string, value: string) {
 const input = fieldInput(label);
 input.value = value;
 input.dispatchEvent(new Event('input', { bubbles: true }));
}

function switchAnyway() {
 Array.from(document.querySelectorAll<HTMLButtonElement>('.overlay[aria-label="Unsaved changes"] button')).find(button => button.textContent === 'Switch anyway')!.click();
}

beforeEach(() => {
 vi.stubGlobal('EventSource', FakeEventSource);
 vi.spyOn(API.prototype, 'facets').mockResolvedValue({ categories: [], kinds: [], resolutions: [], hdr: [], qualities: [], codecs: [] });
 vi.spyOn(API.prototype, 'titles').mockResolvedValue({ items: [], nextCursor: null, total: 0 });
 vi.spyOn(API.prototype, 'ensureMetadata').mockResolvedValue({ queued: 0 });
 vi.spyOn(API.prototype, 'downloads').mockResolvedValue({ items: [], nextCursor: null, total: 0 });
 vi.spyOn(API.prototype, 'call').mockImplementation(fakeCall as typeof API.prototype.call);
});

afterEach(() => {
 while (mountedHosts.length) render(null, mountedHosts.pop()!);
 document.body.innerHTML = '';
 window.history.replaceState(null, '', '/');
 putCalls.length = 0;
 vi.restoreAllMocks();
 vi.unstubAllGlobals();
});

describe('settings tabs', () => {
 it('renders six tabs and opens on Tracker', async () => {
  await openSettings();
  expect(settingsTabs().map(button => button.textContent)).toEqual(['Tracker', 'Storage', 'Playback', 'Server', 'Maintenance', 'Test']);
  expect(settingsTabs()[0].getAttribute('aria-selected')).toBe('true');
  expect(panel().textContent).toContain('FileList URL');
  expect(panel().textContent).not.toContain('qBittorrent URL');
 });

 it('reflects the active tab in the URL hash when switching', async () => {
  await openSettings();
  await act(async () => { settingsTabs()[1].click() });
  await settle();
  expect(location.hash).toBe('#storage');
  expect(panel().textContent).toContain('qBittorrent URL');
  expect(settingsTabs()[1].getAttribute('aria-selected')).toBe('true');
 });

 it('opens the tab named by a deep-linked hash and falls back for unknown hashes', async () => {
  window.history.replaceState(null, '', '/settings#playback');
  await openSettings();
  expect(panel().textContent).toContain('Watched threshold percent');
  expect(location.hash).toBe('#playback');
  window.history.replaceState(null, '', '/settings#nonsense');
  await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')) });
  await settle();
  expect(panel().textContent).toContain('FileList URL');
 });

 it('shows catalog coverage and canonical maintenance actions on the Maintenance tab', async () => {
  await openSettings();
  await act(async () => { settingsTabs().find(button => button.textContent === 'Maintenance')!.click() });
  await settle();
  expect(panel().textContent).toContain('releases retained');
  const labels = panel().querySelectorAll('article h2');
  expect(Array.from(labels).map(node => node.textContent)).toEqual(['Fetch latest', 'Rebuild catalog']);
  const buttons = Array.from(panel().querySelectorAll<HTMLButtonElement>('article button'));
  expect(buttons.map(button => button.textContent)).toEqual(['Fetch latest', 'Rebuild catalog']);
 });

 it('queues Fetch latest immediately and gates Rebuild catalog behind confirmation', async () => {
  const sync = vi.spyOn(API.prototype, 'syncCatalog').mockResolvedValue(syncJob);
  await openSettings();
  await act(async () => { settingsTabs().find(button => button.textContent === 'Maintenance')!.click() });
  await settle();
  const buttons = Array.from(panel().querySelectorAll<HTMLButtonElement>('article button'));
  await act(async () => { buttons[0].click() });
  await settle();
  expect(sync).toHaveBeenCalledWith('latest');
  expect(panel().textContent).toContain('queued');
  await act(async () => { Array.from(panel().querySelectorAll<HTMLButtonElement>('article button'))[1].click() });
  await settle();
  expect(sync).not.toHaveBeenCalledWith('rebuild');
  const dialog = document.querySelector('.overlay[role="dialog"][aria-label="Rebuild catalog"]')!;
  expect(dialog).not.toBeNull();
  const confirmButton = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'Rebuild now')!;
  await act(async () => { confirmButton.click() });
  await settle();
  expect(sync).toHaveBeenCalledWith('rebuild');
  expect(document.querySelector('.overlay[aria-label="Rebuild catalog"]')).toBeNull();
 });
 it('runs all five connection tests from the Test tab', async () => {
  await openSettings();
  await act(async () => { settingsTabs().find(button => button.textContent === 'Test')!.click() });
  await settle();
  const buttons = Array.from(panel().querySelectorAll<HTMLButtonElement>('button')).filter(button => button.textContent?.startsWith('Test '));
  expect(buttons.map(button => button.textContent)).toEqual(['Test FileList', 'Test TMDB', 'Test qBittorrent', 'Test Storage', 'Test SubDL']);
  await act(async () => { buttons[4].click() });
  await settle();
  expect(panel().textContent).toContain('/dependencies/subdl/test ok');
 });

 it('places connection tests beside their fields and aggregates them on the Test tab', async () => {
  await openSettings();
  const checkLabels = () => Array.from(panel().querySelectorAll<HTMLButtonElement>('.diagnostics button')).map(button => button.textContent);
  expect(checkLabels()).toEqual(['Test FileList', 'Test TMDB']);
  await act(async () => { settingsTabs()[1].click() });
  await settle();
  expect(checkLabels()).toEqual(['Test qBittorrent', 'Test Storage']);
  await act(async () => { settingsTabs()[2].click() });
  await settle();
  expect(checkLabels()).toEqual(['Test SubDL']);
  await act(async () => { settingsTabs()[5].click() });
  await settle();
  expect(checkLabels()).toEqual(['Test FileList', 'Test TMDB', 'Test qBittorrent', 'Test Storage', 'Test SubDL']);
  await act(async () => { settingsTabs()[4].click() });
  await settle();
  expect(panel().querySelectorAll<HTMLButtonElement>('.diagnostics button')).toHaveLength(0);
 });

 it('reflects session test results in the tab LED and inline text', async () => {
  await openSettings();
  const trackerTab = settingsTabs()[0];
  const led = () => trackerTab.querySelector('.led')!;
  expect(led().className).not.toContain('pass');
  await act(async () => { Array.from(panel().querySelectorAll<HTMLButtonElement>('.diagnostics button')).find(button => button.textContent === 'Test FileList')!.click() });
  await settle();
  expect(led().className).toContain('pass');
  expect(panel().textContent).toContain('/dependencies/filelist/test ok');
  vi.spyOn(API.prototype, 'call').mockImplementation(async (path: string, init?: RequestInit) => {
   if (path === '/dependencies/tmdb/test') throw new Error('TMDB unreachable');
   return fakeCall(path, init);
  });
  await act(async () => { Array.from(panel().querySelectorAll<HTMLButtonElement>('.diagnostics button')).find(button => button.textContent === 'Test TMDB')!.click() });
  await settle();
  expect(led().className).toContain('fail');
  expect(panel().textContent).toContain('TMDB unreachable');

 });
 it('fires beforeunload only while any tab is dirty and disarms after save', async () => {
  await openSettings();
  const fireBeforeUnload = () => {
   const event = new Event('beforeunload', { cancelable: true });
   window.dispatchEvent(event);
   return event.defaultPrevented;
  };
  expect(fireBeforeUnload()).toBe(false);
  await act(async () => { setFieldInput('FileList URL', 'https://unload-guard.example') });
  await settle();
  expect(fireBeforeUnload()).toBe(true);
  await act(async () => { document.querySelector<HTMLButtonElement>('.settings-actions button[type="submit"]')!.click() });
  await settle();
  expect(fireBeforeUnload()).toBe(false);
 });

 it('asks before switching tabs with unsaved edits and can keep editing or switch anyway', async () => {
  await openSettings();
  await act(async () => { setFieldInput('FileList URL', 'https://guarded.example') });
  await act(async () => { settingsTabs()[1].click() });
  await settle();
  expect(location.hash).not.toBe('#storage');
  const dialog = document.querySelector('.overlay[aria-label="Unsaved changes"]')!;
  expect(dialog).not.toBeNull();
  await act(async () => { Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'Keep editing')!.click() });
  await settle();
  expect(document.querySelector('.overlay[aria-label="Unsaved changes"]')).toBeNull();
  expect(settingsTabs()[0].getAttribute('aria-selected')).toBe('true');
  expect(fieldInput('FileList URL').value).toBe('https://guarded.example');
  await act(async () => { settingsTabs()[1].click() });
  await settle();
  await act(async () => { switchAnyway() });
  await settle();
  expect(settingsTabs()[1].getAttribute('aria-selected')).toBe('true');
  expect(settingsTabs()[0].className).toContain('dirty');
  expect(putCalls).toHaveLength(0);
 });

 it('guards sidebar navigation away from dirty settings', async () => {
  await openSettings();
  await act(async () => { setFieldInput('FileList URL', 'https://nav-guard.example') });
  await act(async () => { sidebarButton('Jobs').click() });
  await settle();
  const dialog = document.querySelector('.overlay[aria-label="Unsaved changes"]')!;
  expect(dialog).not.toBeNull();
  expect(document.querySelector('.topbar h1')!.textContent).toBe('Settings');
  await act(async () => { Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'Keep editing')!.click() });
  await settle();
  expect(document.querySelector('.topbar h1')!.textContent).toBe('Settings');
  await act(async () => { sidebarButton('Jobs').click() });
  await settle();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>('.overlay[aria-label="Unsaved changes"] button')).find(button => button.textContent === 'Discard and leave')!.click() });
  await settle();
  expect(document.querySelector('.topbar h1')!.textContent).toBe('Jobs');
  expect(document.querySelector('.overlay[aria-label="Unsaved changes"]')).toBeNull();
 });

 it('never guards when everything is clean', async () => {
  await openSettings();

  await act(async () => { sidebarButton('Jobs').click() });
  await settle();
  expect(document.querySelector('.overlay[aria-label="Unsaved changes"]')).toBeNull();
  expect(document.querySelector('.topbar h1')!.textContent).toBe('Jobs');
 });

 it('edits subtitle settings in exactly one place', async () => {
  await openSettings();
  await act(async () => { settingsTabs().find(button => button.textContent === 'Playback')!.click() });
  await settle();
  expect(document.querySelectorAll('form.subtitle-provider-settings')).toHaveLength(0);
  const subdlLabels = Array.from(panel().querySelectorAll('label > span')).filter(span => span.textContent?.startsWith('SubDL API URL'));
  expect(subdlLabels).toHaveLength(1);
  expect(panel().textContent).toContain('Subtitle cache path');
  expect(panel().textContent).toContain('ffprobe path');
 });

 it('saves one tab merged over last-saved values without sweeping other tabs\' edits', async () => {
  await openSettings();
  await act(async () => { settingsTabs()[1].click() });
  await settle();
  await act(async () => { setFieldInput('Download root', '/srv/new') });
  await act(async () => { settingsTabs()[0].click() });
  await act(async () => { switchAnyway() });
  await settle();
  await act(async () => { setFieldInput('FileList URL', 'https://filelist-edited.example') });
  await act(async () => { settingsTabs()[1].click() });
  await act(async () => { switchAnyway() });
  await settle();
  await act(async () => { document.querySelector<HTMLButtonElement>('.settings-actions button[type="submit"]')!.click() });
  await settle();
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0].body.downloadRoot).toBe('/srv/new');
  expect(putCalls[0].body.fileListUrl).toBe('https://filelist.io');
  expect(document.querySelector('.settings-actions')!.textContent).toContain('Settings saved.');
 });

 it('discards the tab back to last-saved values and never sends them', async () => {
  await openSettings();
  await act(async () => { setFieldInput('FileList URL', 'https://discarded.example') });
  await settle();
  await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-actions button')).find(button => button.textContent === 'Discard changes')!.click() });
  await settle();
  expect(fieldInput('FileList URL').value).toBe('https://filelist.io');
  expect(putCalls).toHaveLength(0);
 });

 it('marks dirty tabs, counts unsaved changes, and disables actions when clean', async () => {
  await openSettings();
  expect(document.querySelector('.settings-actions button[type="submit"]')!.hasAttribute('disabled')).toBe(true);
  await act(async () => { setFieldInput('TMDB API key or token', 'tmdb-edited') });
  await settle();
  expect(document.querySelector('.settings-actions')!.textContent).toContain('1 unsaved change');
  expect(settingsTabs()[0].className).toContain('dirty');
  await act(async () => { settingsTabs()[3].click() });
  await act(async () => { switchAnyway() });
  await settle();
  expect(document.querySelector('.settings-actions button[type="submit"]')!.hasAttribute('disabled')).toBe(true);
  expect(settingsTabs()[0].className).toContain('dirty');
  expect(settingsTabs()[3].className).not.toContain('dirty');
  await act(async () => { settingsTabs()[0].click() });
  await act(async () => { switchAnyway() });
  await settle();
  await act(async () => { document.querySelector<HTMLButtonElement>('.settings-actions button[type="submit"]')!.click() });
  await settle();
  expect(settingsTabs()[0].className).not.toContain('dirty');
  expect(putCalls[0].body.tmdbApiKey).toBe('tmdb-edited');
 });
 it('preserves the settings payload contract and field states', async () => {
  await openSettings();
  expect(fieldInput('FileList passkey').placeholder).toBe('Configured — leave blank to keep');
  await act(async () => { settingsTabs().find(button => button.textContent === 'Storage')!.click() });
  await settle();
  await act(async () => { setFieldInput('Eviction rules (comma separated)', 'OLDEST-COMPLETED, oldest-unwatched') });
  await act(async () => { document.querySelector<HTMLButtonElement>('.settings-actions button[type="submit"]')!.click() });
  await settle();
  expect(putCalls).toHaveLength(1);
  expect(putCalls[0].body.evictionRules).toEqual(['oldest-completed', 'oldest-unwatched']);
  await act(async () => { settingsTabs().find(button => button.textContent === 'Server')!.click() });
  await settle();
  expect(fieldInput('Listen address').disabled).toBe(true);
  await act(async () => { setFieldInput('Trusted CIDRs (comma separated)', '10.0.0.0/8, 192.168.1.0/24') });
  await act(async () => { document.querySelector('form.settings')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) });
  await settle();
  expect(putCalls).toHaveLength(2);
  const body = putCalls[1].body;
  expect(body.settingsPath).toBeUndefined();
  expect(Object.keys(body).some(key => key.endsWith('Configured'))).toBe(false);
  expect(body.trustedCidrs).toEqual(['10.0.0.0/8', '192.168.1.0/24']);
  expect(body.evictionRules).toEqual(['oldest-completed', 'oldest-unwatched']);
  expect(body.fileListPasskey).toBe('');
 });

 it('shows the testing LED state while a connection check is in flight', async () => {
  await openSettings();
  const { promise, resolve } = Promise.withResolvers<{ message: string }>();
  vi.spyOn(API.prototype, 'call').mockImplementationOnce(() => promise);
  await act(async () => { Array.from(panel().querySelectorAll<HTMLButtonElement>('.diagnostics button')).find(button => button.textContent === 'Test FileList')!.click() });
  await settle();
  expect(settingsTabs()[0].querySelector('.led')!.className).toContain('testing');
  await act(async () => { resolve({ message: 'filelist ok' }) });
  await settle();
  expect(settingsTabs()[0].querySelector('.led')!.className).toContain('pass');
 });
});
