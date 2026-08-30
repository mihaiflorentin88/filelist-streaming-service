// The Settings surface: a tabbed editor for server configuration plus the
// catalog sync maintenance actions and observed catalog coverage. The app
// renders these on both the Settings and Events views.
import { useEffect, useState } from 'preact/hooks';
import { API, SettingsField } from '@filelist/shared';

const api = new API(location.origin);

export function Events({ onError, confirmRebuild = false }: { onError: (value: string) => void; confirmRebuild?: boolean }) {
  const [message, setMessage] = useState('');
  const [pendingRebuild, setPendingRebuild] = useState(false);
  async function run(mode: 'latest' | 'rebuild') { try { const job = await api.syncCatalog(mode); setMessage(`${job.label} queued. Follow progress on Jobs.`) } catch (e) { onError((e as Error).message) } finally { setPendingRebuild(false) } }
  // The standalone Events page keeps the one-click behavior; the Settings
  // Maintenance tab asks first because the rebuild sweeps every category.
  const requestRebuild = () => { if (confirmRebuild) setPendingRebuild(true); else void run('rebuild') };
  return <section class="events-page"><p class="supporting">Run safe server maintenance without waiting for the schedule.</p><div class="event-actions"><article><h2>Fetch latest</h2><p>Append the newest FileList releases to the existing catalog.</p><button type="button" class="primary" onClick={() => void run('latest')}>Fetch latest</button></article><article><h2>Rebuild catalog</h2><p>Refresh the maximum API-visible results from every enabled category. Existing discoveries are retained.</p><button type="button" onClick={requestRebuild}>Rebuild catalog</button></article></div>{message && <p role="status" class="success">{message}</p>}{pendingRebuild && <div class="overlay" role="dialog" aria-modal="true" aria-label="Rebuild catalog"><section class="help-modal"><h2>Rebuild catalog?</h2><p>Refreshes every enabled category's latest window and rebuilds local projections. Nothing is removed; the work runs as a background job you can follow on the Jobs page.</p><div class="confirm-actions"><button type="button" onClick={() => setPendingRebuild(false)}>Cancel</button><button type="button" class="primary" onClick={() => void run('rebuild')}>Rebuild now</button></div></section></div>}</section>
}

export function CacheCoverage() { const [status, setStatus] = useState<Record<string, unknown> | null>(null); useEffect(() => { api.call<Record<string, unknown>>('/catalog/status').then(setStatus).catch(() => { }) }, []); if (!status) return null; return <section class="cache-coverage"><h2>Observed catalog coverage</h2><p><strong>{Number(status.observedReleases).toLocaleString()}</strong> releases retained · <strong>{Number(status.discoverableReleases).toLocaleString()}</strong> currently seeded · {Number(status.hiddenZeroSeeders).toLocaleString()} zero-seeder releases hidden</p><p class="supporting">FileList exposes at most {String(status.fileListLatestWindowLimit)} recent releases per latest request and no historical pagination. Searches and future syncs continue growing this append-only cache.</p></section> }

type SettingsRow = [string, string, string?, string?];

// Connection checks live beside the fields they validate and gather on the
// Test tab. LED state is session-scoped: it starts untested and changes only
// from tests actually run in this session.
const CONNECTIONS = [
  { name: 'filelist', label: 'FileList', tab: 'tracker' },
  { name: 'tmdb', label: 'TMDB', tab: 'tracker' },
  { name: 'qbittorrent', label: 'qBittorrent', tab: 'storage' },
  { name: 'storage', label: 'Storage', tab: 'storage' },
  { name: 'subdl', label: 'SubDL', tab: 'playback' },
];

const connectionsFor = (tab: string) => CONNECTIONS.filter(connection => connection.tab === tab);

const TABS: Array<{ id: string; label: string; ops?: boolean }> = [
  { id: 'tracker', label: 'Tracker' },
  { id: 'storage', label: 'Storage' },
  { id: 'playback', label: 'Playback' },
  { id: 'server', label: 'Server' },
  { id: 'maintenance', label: 'Maintenance', ops: true },
  { id: 'test', label: 'Test', ops: true },
];

const TAB_GROUPS: Record<string, Array<{ title: string; fields: SettingsRow[] }>> = {
  tracker: [
    { title: 'Tracker and metadata', fields: [['FileList URL', 'fileListUrl'], ['FileList username', 'fileListUsername'], ['FileList passkey', 'fileListPasskey', 'password'], ['TMDB API key or token', 'tmdbApiKey', 'password'], ['Metadata language', 'metadataLanguage'], ['Metadata fallback language', 'metadataFallbackLanguage']] },
  ],
  storage: [
    { title: 'qBittorrent and storage', fields: [['qBittorrent URL', 'qbittorrentUrl'], ['qBittorrent username', 'qbittorrentUsername'], ['qBittorrent password', 'qbittorrentPassword', 'password'], ['Download root', 'downloadRoot'], ['Allocation (GB)', 'allocationGb', 'number', '0.5'], ['Free-space reserve (GB)', 'reserveGb', 'number', '0.5'], ['Eviction rules (comma separated)', 'evictionRules'], ['Protect incomplete downloads', 'protectIncomplete', 'checkbox'], ['Protect actively streamed downloads', 'protectLeased', 'checkbox'], ['Protect favorites', 'protectFavorites', 'checkbox'], ['Protect never-watched downloads', 'protectNeverWatched', 'checkbox'], ['Artwork cache path', 'artworkCachePath'], ['Artwork cache maximum bytes', 'artworkCacheMaxBytes', 'number']] },
  ],
  playback: [
    { title: 'Playback and subtitles', fields: [['Initial buffer bytes', 'initialBufferBytes', 'number'], ['Read-ahead bytes', 'readAheadBytes', 'number'], ['Piece timeout seconds', 'pieceWaitTimeoutSeconds', 'number'], ['SubDL API URL', 'subDLUrl'], ['SubDL API key', 'subDLApiKey', 'password'], ['Preferred audio language', 'preferredAudioLanguage'], ['Preferred subtitle language', 'preferredSubtitleLanguage'], ['Fallback subtitle language', 'fallbackSubtitleLanguage'], ['Watched threshold percent', 'watchedThresholdPercent', 'number'], ['Subtitle cache path', 'subtitleCachePath'], ['Subtitle cache maximum bytes', 'subtitleCacheMaxBytes', 'number'], ['ffprobe path', 'ffprobePath'], ['FFmpeg path', 'ffmpegPath']] },
  ],
  server: [
    { title: 'Server and background work', fields: [['Server name', 'instanceName'], ['Listen address', 'listenAddress'], ['Database path', 'databasePath'], ['Catalog max age hours', 'catalogMaxAgeHours', 'number'], ['Maximum concurrent jobs', 'maxConcurrentJobs', 'number'], ['Title refresh timeout minutes', 'titleRefreshTimeoutMinutes', 'number'], ['Trusted CIDRs (comma separated)', 'trustedCidrs']] },
  ],
};

// The active tab rides the URL hash so refresh and shared links reopen the
// same section; anything unknown falls back to the first tab.
function tabFromHash(): string {
  const id = location.hash.replace(/^#/, '');
  return TABS.some(tab => tab.id === id) ? id : 'tracker';
}

const tabFieldKeys = (id: string): string[] => (TAB_GROUPS[id] || []).flatMap(group => group.fields.map(field => field[1]));
const isConfigTab = (id: string) => Boolean(TAB_GROUPS[id]);

export function Settings({ value, fields, onSaved, onError, onDirtyChange }: { value: Record<string, unknown>; fields: SettingsField[]; onSaved: (v: Record<string, unknown>) => void; onError: (s: string) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [current, setCurrent] = useState({ ...value });
  const [message, setMessage] = useState('');
  const [help, setHelp] = useState<SettingsField | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [connState, setConnState] = useState<Record<string, string>>({});
  const [tab, setTabState] = useState(tabFromHash);
  const setTab = (id: string) => { setTabState(id); history.replaceState(null, '', `#${id}`) };
  const tabEdits = (id: string) => tabFieldKeys(id).filter(key => current[key] !== value[key]);
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const anyDirty = () => TABS.some(entry => tabEdits(entry.id).length > 0);
  // Tab switches ask first while anything on the page is dirty; the
  // beforeunload prompt covers browser close and refresh.
  const requestTab = (id: string) => {
    if (id === tab || !anyDirty()) { setTab(id); return }
    setPendingTab(id);
  };
  useEffect(() => {
    onDirtyChange?.(anyDirty());
  });
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!anyDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });
  const tabLed = (id: string) => {
    const states = connectionsFor(id).map(connection => connState[connection.name]);
    if (states.includes('fail')) return 'fail';
    if (states.includes('testing')) return 'testing';
    if (states.includes('pass')) return 'pass';
    return '';
  };
  useEffect(() => {
    const followHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);
  const descriptor = (key: string, label: string) => fields.find(field => field.key === key) || { key, label, help: `Controls ${label.toLowerCase()}.`, obtain: '', tvVisible: false, sensitive: false, restartRequired: false, readOnly: false };
  async function save(e: Event) {
    e.preventDefault();
    // One PUT carries the whole settings object, but only the active tab's
    // edits ride on top of the last-saved values — edits made on other tabs
    // stay pending until their own tab is saved.
    const merged: Record<string, unknown> = { ...value };
    tabFieldKeys(tab).forEach(key => { merged[key] = current[key] });
    const out = { ...merged };
    Object.keys(out).filter(k => k.endsWith('Configured') || k === 'settingsPath').forEach(k => delete out[k]);
    if (typeof out.trustedCidrs === 'string') out.trustedCidrs = out.trustedCidrs.split(',').map((x: string) => x.trim()).filter(Boolean);
    if (typeof out.evictionRules === 'string') out.evictionRules = (out.evictionRules as string).split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean);
    try {
      await api.call('/settings', { method: 'PUT', body: JSON.stringify(out) });
      setMessage('Settings saved. Environment-managed values remain controlled by .env.docker.');
      onSaved(merged);
    } catch (e) { onError((e as Error).message) }
  }
  function discard() {
    const reverted = { ...current };
    tabFieldKeys(tab).forEach(key => { reverted[key] = value[key] });
    setCurrent(reverted);
    setMessage('');
  }
  async function test(name: string) {
    setTests(current => ({ ...current, [name]: 'Testing…' }));
    setConnState(current => ({ ...current, [name]: 'testing' }));
    try {
      const result = await api.call<{ message: string }>(`/dependencies/${name}/test`, { method: 'POST' });
      setTests(current => ({ ...current, [name]: result.message }));
      setConnState(current => ({ ...current, [name]: 'pass' }));
    } catch (e) {
      setTests(current => ({ ...current, [name]: (e as Error).message }));
      setConnState(current => ({ ...current, [name]: 'fail' }));
    }
  }
  const renderField = ([label, key, type, step]: SettingsRow) => {
    const info = descriptor(key, label);
    if (type === 'checkbox') {
      // Protection flags render as switches: a real checkbox stays in the
      // DOM (visually hidden, still focusable) for keyboard and assistive
      // tech, with the track and knob as decoration.
      return <label class="switch-field"><input disabled={info.readOnly} type="checkbox" checked={Boolean(current[key])} onInput={e => setCurrent({ ...current, [key]: e.currentTarget.checked })} /><span class="switch-track" aria-hidden="true"><span class="switch-knob" /></span><span class="switch-copy">{label}{info.help && <button type="button" class="help-button" aria-label={`Help for ${label}`} title={info.help} onClick={() => setHelp(info)}>?</button>}</span></label>;
    }
    return <label><span>{label}{info.restartRequired && <small> restart required</small>}{info.readOnly && <small> environment managed</small>}<button type="button" class="help-button" aria-label={`Help for ${label}`} title={info.help} onClick={() => setHelp(info)}>?</button></span><input disabled={info.readOnly} type={type || 'text'} step={type === 'number' ? (step || undefined) : undefined} value={Array.isArray(current[key]) ? (current[key] as string[]).join(', ') : String(current[key] ?? '')} placeholder={type === 'password' && value[`${key}Configured`] ? 'Configured — leave blank to keep' : key === 'evictionRules' ? 'oldest-completed' : ''} onInput={e => setCurrent({ ...current, [key]: type === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value })} /></label>;
  };
  const diagnostics = (connections: typeof CONNECTIONS) => <section class="diagnostics"><h2>Connection checks</h2>{connections.map(connection => <div><button type="button" onClick={() => void test(connection.name)}>Test {connection.label}</button><span role="status">{tests[connection.name]}</span></div>)}</section>;
  const panelContent = () => {
    if (tab === 'maintenance') return <><CacheCoverage /><Events onError={onError} confirmRebuild /></>;
    if (tab === 'test') return diagnostics(CONNECTIONS);
    return <>{TAB_GROUPS[tab].map(renderGroup)}{connectionsFor(tab).length > 0 && diagnostics(connectionsFor(tab))}</>;
  };
  const renderGroup = (group: { title: string; fields: SettingsRow[] }) => {
    // Switches read best as their own full-width list under the value fields.
    const inputs = group.fields.filter(field => field[2] !== 'checkbox');
    const switches = group.fields.filter(field => field[2] === 'checkbox');
    return <fieldset><legend>{group.title}</legend>{inputs.length > 0 && <div class="fields">{inputs.map(renderField)}</div>}{switches.length > 0 && <div class="switch-list">{switches.map(renderField)}</div>}</fieldset>;
  };
  return <>
    <form class="settings" onSubmit={save}>
      <p class="supporting">Stored securely at {String(value.settingsPath || 'data/settings.json')}. Blank secrets keep their current value. Fields supplied by the process environment are shown read-only.</p>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(t => <button type="button" role="tab" class={[t.id === 'maintenance' ? 'ops-start' : '', tabEdits(t.id).length > 0 ? 'dirty' : ''].filter(Boolean).join(' ')} aria-selected={tab === t.id} onClick={() => requestTab(t.id)}>{connectionsFor(t.id).length > 0 && <span class={`led ${tabLed(t.id)}`} aria-hidden="true" />}{t.label}</button>)}
      </div>
      <div class="settings-panel" role="tabpanel">{panelContent()}</div>
      {isConfigTab(tab) && <div class="settings-actions"><span class="dirty-count" role="status">{tabEdits(tab).length > 0 ? `${tabEdits(tab).length} unsaved ${tabEdits(tab).length === 1 ? 'change' : 'changes'}` : ''}</span><button type="button" disabled={tabEdits(tab).length === 0} onClick={discard}>Discard changes</button><button class="primary" type="submit" disabled={tabEdits(tab).length === 0}>Save changes</button>{message && <span role="status">{message}</span>}</div>}
    </form>
    {help && <div class="overlay" role="dialog" aria-modal="true" aria-label={`Help for ${help.label}`}><section class="help-modal"><button class="close" onClick={() => setHelp(null)}>Close</button><h2>{help.label}</h2><p>{help.help}</p>{help.readOnly && <p><strong>This setting is managed by the process environment and cannot be edited here.</strong></p>}{help.restartRequired && <p><strong>Restart required after changing this setting.</strong></p>}{help.obtain && <><h3>Where to get it</h3><p>{help.obtain}</p></>}<button onClick={() => void navigator.clipboard.writeText([help.help, help.obtain].filter(Boolean).join('\n\n')).then(() => setMessage('Help copied.'))}>Copy help</button></section></div>}
    {pendingTab !== null && <div class="overlay" role="dialog" aria-modal="true" aria-label="Unsaved changes"><section class="help-modal"><h2>Tab has unsaved changes</h2><p>Unsaved changes on this tab stay pending — the tab label keeps its dot until you save or discard them.</p><div class="confirm-actions"><button type="button" onClick={() => setPendingTab(null)}>Keep editing</button><button type="button" class="primary" onClick={() => { const target = pendingTab; setPendingTab(null); setTab(target) }}>Switch anyway</button></div></section></div>}
  </>
}
