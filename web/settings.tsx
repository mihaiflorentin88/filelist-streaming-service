// The Settings surface: main settings form, subtitle provider fields, catalog
// sync maintenance actions, and observed catalog coverage. The app renders
// these on both the Settings and Events views.
import { useEffect, useState } from 'preact/hooks';
import { API, SettingsField } from '@filelist/shared';

const api = new API(location.origin);
export function Events({ onError }: { onError: (value: string) => void }) { const [message, setMessage] = useState(''); async function run(mode: 'latest' | 'rebuild') { try { const job = await api.syncCatalog(mode); setMessage(`${job.label} queued. Follow progress on Jobs.`) } catch (e) { onError((e as Error).message) } } return <section class="events-page"><p class="supporting">Run safe server maintenance without waiting for the schedule.</p><div class="event-actions"><article><h2>Fetch latest</h2><p>Append the newest FileList releases to the existing catalog.</p><button class="primary" onClick={() => void run('latest')}>Fetch latest data</button></article><article><h2>Rebuild catalog</h2><p>Refresh the maximum API-visible results from every enabled category. Existing discoveries are retained.</p><button onClick={() => void run('rebuild')}>Rebuild cache</button></article></div>{message && <p role="status" class="success">{message}</p>}</section> }

export function CacheCoverage() { const [status, setStatus] = useState<Record<string, unknown> | null>(null); useEffect(() => { api.call<Record<string, unknown>>('/catalog/status').then(setStatus).catch(() => { }) }, []); if (!status) return null; return <section class="cache-coverage"><h2>Observed catalog coverage</h2><p><strong>{Number(status.observedReleases).toLocaleString()}</strong> releases retained · <strong>{Number(status.discoverableReleases).toLocaleString()}</strong> currently seeded · {Number(status.hiddenZeroSeeders).toLocaleString()} zero-seeder releases hidden</p><p class="supporting">FileList exposes at most {String(status.fileListLatestWindowLimit)} recent releases per latest request and no historical pagination. Searches and future syncs continue growing this append-only cache.</p></section> }

export function SubtitleProviderSettings({ value, fields, onSaved, onError }: { value: Record<string, unknown>; fields: SettingsField[]; onSaved: (value: Record<string, unknown>) => void; onError: (message: string) => void }) {
  const [current, setCurrent] = useState({ ...value }); const [help, setHelp] = useState<SettingsField | null>(null); const [message, setMessage] = useState(''); const [tests, setTests] = useState<Record<string, string>>({});
  const rows: [string, string, string?][] = [['Preferred audio language', 'preferredAudioLanguage'], ['Preferred subtitle language', 'preferredSubtitleLanguage'], ['Fallback subtitle language', 'fallbackSubtitleLanguage'], ['SubDL API URL', 'subDLUrl'], ['SubDL API key', 'subDLApiKey', 'password'], ['Subtitle cache path', 'subtitleCachePath'], ['Subtitle cache maximum bytes', 'subtitleCacheMaxBytes', 'number'], ['ffprobe path', 'ffprobePath'], ['FFmpeg path', 'ffmpegPath']];
  const descriptor = (key: string, label: string) => fields.find(field => field.key === key) || { key, label, help: `Controls ${label.toLowerCase()}.`, obtain: '', tvVisible: false, sensitive: false, restartRequired: false };
  async function save(event: Event) { event.preventDefault(); const out = { ...current }; Object.keys(out).filter(key => key.endsWith('Configured') || key === 'settingsPath').forEach(key => delete out[key]); if (typeof out.trustedCidrs === 'string') out.trustedCidrs = out.trustedCidrs.split(',').map((item: string) => item.trim()).filter(Boolean); try { await api.call('/settings', { method: 'PUT', body: JSON.stringify(out) }); setMessage('Subtitle provider settings saved.'); onSaved(current) } catch (error) { onError((error as Error).message) } }
  async function test(name: 'subdl') { setTests(state => ({ ...state, [name]: 'Testing saved credentials…' })); try { const result = await api.call<{ message: string }>(`/dependencies/${name}/test`, { method: 'POST' }); setTests(state => ({ ...state, [name]: result.message })) } catch (error) { setTests(state => ({ ...state, [name]: (error as Error).message })) } }
  return <form class="settings subtitle-provider-settings" onSubmit={save}><fieldset><legend>Subtitle providers</legend><p class="supporting">Save credentials before testing them. Blank secrets keep their currently stored value.</p><section class="diagnostics"><h2>Provider connections</h2><div><button type="button" onClick={() => void test('subdl')}>Test SubDL</button><span role="status">{tests.subdl}</span></div></section><div class="fields">{rows.map(([label, key, type]) => { const info = descriptor(key, label); return <label><span>{label}{info.readOnly && <small> environment managed</small>}<button type="button" class="help-button" aria-label={`Help for ${label}`} title={info.help} onClick={() => setHelp(info)}>?</button></span><input disabled={info.readOnly} type={type || 'text'} value={String(current[key] ?? '')} placeholder={type === 'password' && value[`${key}Configured`] ? 'Configured — leave blank to keep' : ''} onInput={event => setCurrent({ ...current, [key]: type === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value })} /></label> })}</div></fieldset><div class="settings-actions"><button class="primary" type="submit">Save subtitle settings</button><span role="status">{message}</span></div>{help && <div class="overlay" role="dialog" aria-modal="true" aria-label={`Help for ${help.label}`}><section class="help-modal"><button type="button" class="close" onClick={() => setHelp(null)}>Close</button><h2>{help.label}</h2><p>{help.help}</p>{help.obtain && <><h3>Where to get it</h3><p>{help.obtain}</p></>}<button type="button" onClick={() => void navigator.clipboard.writeText([help.help, help.obtain].filter(Boolean).join('\n\n')).then(() => setMessage('Help copied.'))}>Copy help</button></section></div>}</form>
}

export function Settings({ value, fields, onSaved, onError }: { value: Record<string, unknown>; fields: SettingsField[]; onSaved: (v: Record<string, unknown>) => void; onError: (s: string) => void }) {
  const [current, setCurrent] = useState({ ...value });
  const [message, setMessage] = useState('');
  const [help, setHelp] = useState<SettingsField | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const groups = [
    { title: 'Tracker and metadata', fields: [['FileList URL', 'fileListUrl'], ['FileList username', 'fileListUsername'], ['FileList passkey', 'fileListPasskey', 'password'], ['TMDB API key or token', 'tmdbApiKey', 'password'], ['Metadata language', 'metadataLanguage'], ['Metadata fallback language', 'metadataFallbackLanguage']] },
    { title: 'qBittorrent and storage', fields: [['qBittorrent URL', 'qbittorrentUrl'], ['qBittorrent username', 'qbittorrentUsername'], ['qBittorrent password', 'qbittorrentPassword', 'password'], ['Download root', 'downloadRoot'], ['Allocation (GB)', 'allocationGb', 'number', '0.5'], ['Free-space reserve (GB)', 'reserveGb', 'number', '0.5'], ['Eviction rules (comma separated)', 'evictionRules'], ['Protect incomplete downloads', 'protectIncomplete', 'checkbox'], ['Protect actively streamed downloads', 'protectLeased', 'checkbox'], ['Protect favorites', 'protectFavorites', 'checkbox'], ['Protect never-watched downloads', 'protectNeverWatched', 'checkbox'], ['Artwork cache path', 'artworkCachePath'], ['Artwork cache maximum bytes', 'artworkCacheMaxBytes', 'number']] },
    { title: 'Playback and subtitles', fields: [['Initial buffer bytes', 'initialBufferBytes', 'number'], ['Read-ahead bytes', 'readAheadBytes', 'number'], ['Piece timeout seconds', 'pieceWaitTimeoutSeconds', 'number'], ['SubDL API URL', 'subDLUrl'], ['SubDL API key', 'subDLApiKey', 'password'], ['Preferred audio language', 'preferredAudioLanguage'], ['Preferred subtitle language', 'preferredSubtitleLanguage'], ['Fallback subtitle language', 'fallbackSubtitleLanguage'], ['Watched threshold percent', 'watchedThresholdPercent', 'number']] },
    { title: 'Server and background work', fields: [['Server name', 'instanceName'], ['Listen address', 'listenAddress'], ['Database path', 'databasePath'], ['Catalog max age hours', 'catalogMaxAgeHours', 'number'], ['Maximum concurrent jobs', 'maxConcurrentJobs', 'number'], ['Title refresh timeout minutes', 'titleRefreshTimeoutMinutes', 'number'], ['Trusted CIDRs (comma separated)', 'trustedCidrs']] },
  ] as any[];
  const descriptor = (key: string, label: string) => fields.find(field => field.key === key) || { key, label, help: `Controls ${label.toLowerCase()}.`, obtain: '', tvVisible: false, sensitive: false, restartRequired: false, readOnly: false };
  async function save(e: Event) {
    e.preventDefault();
    const out = { ...current };
    Object.keys(out).filter(k => k.endsWith('Configured') || k === 'settingsPath').forEach(k => delete out[k]);
    if (typeof out.trustedCidrs === 'string') out.trustedCidrs = out.trustedCidrs.split(',').map((x: string) => x.trim()).filter(Boolean);
    if (typeof out.evictionRules === 'string') out.evictionRules = (out.evictionRules as string).split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean);
    try {
      await api.call('/settings', { method: 'PUT', body: JSON.stringify(out) });
      setMessage('Settings saved. Environment-managed values remain controlled by .env.docker.');
      onSaved(current);
    } catch (e) { onError((e as Error).message) }
  }
  async function test(name: string) {
    setTests({ ...tests, [name]: 'Testing…' });
    try {
      const result = await api.call<{ message: string }>(`/dependencies/${name}/test`, { method: 'POST' });
      setTests(current => ({ ...current, [name]: result.message }));
    } catch (e) { setTests(current => ({ ...current, [name]: (e as Error).message })) }
  }
  return <>
    <form class="settings" onSubmit={save}>
      <p class="supporting">Stored securely at {String(value.settingsPath || 'data/settings.json')}. Blank secrets keep their current value. Fields supplied by the process environment are shown read-only.</p>
      <section class="diagnostics"><h2>Connections</h2>{['filelist', 'qbittorrent', 'storage', 'tmdb', 'subdl'].map(name => <div><button type="button" onClick={() => void test(name)}>Test {name}</button><span role="status">{tests[name]}</span></div>)}</section>
      {groups.map(g => <fieldset><legend>{g.title}</legend><div class="fields">{g.fields.map(([label, key, type, step]: string[]) => {
        const info = descriptor(key, label);
        return <label><span>{label}{info.restartRequired && <small> restart required</small>}{info.readOnly && <small> environment managed</small>}<button type="button" class="help-button" aria-label={`Help for ${label}`} title={info.help} onClick={() => setHelp(info)}>?</button></span>{type === 'checkbox' ? <input disabled={info.readOnly} type="checkbox" checked={Boolean(current[key])} onInput={e => setCurrent({ ...current, [key]: e.currentTarget.checked })} /> : <input disabled={info.readOnly} type={type || 'text'} step={type === 'number' ? (step || undefined) : undefined} value={Array.isArray(current[key]) ? (current[key] as string[]).join(', ') : String(current[key] ?? '')} placeholder={type === 'password' && value[`${key}Configured`] ? 'Configured — leave blank to keep' : key === 'evictionRules' ? 'oldest-completed' : ''} onInput={e => setCurrent({ ...current, [key]: type === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value })} />}</label>
      })}</div></fieldset>)}
      <Events onError={onError} />
      <div class="settings-actions"><button class="primary" type="submit">Save changes</button>{message && <span role="status">{message}</span>}</div>
    </form>
    {help && <div class="overlay" role="dialog" aria-modal="true" aria-label={`Help for ${help.label}`}><section class="help-modal"><button class="close" onClick={() => setHelp(null)}>Close</button><h2>{help.label}</h2><p>{help.help}</p>{help.readOnly && <p><strong>This setting is managed by the process environment and cannot be edited here.</strong></p>}{help.restartRequired && <p><strong>Restart required after changing this setting.</strong></p>}{help.obtain && <><h3>Where to get it</h3><p>{help.obtain}</p></>}<button onClick={() => void navigator.clipboard.writeText([help.help, help.obtain].filter(Boolean).join('\n\n')).then(() => setMessage('Help copied.'))}>Copy help</button></section></div>}
  </>
}
