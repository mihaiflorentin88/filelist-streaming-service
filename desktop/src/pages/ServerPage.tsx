import { useEffect, useState } from 'preact/hooks';
import {
  AutostartStatus,
  ChangeDataDir,
  DataDirInfo,
  DisableAutostart,
  EnableAutostart,
  LoadSettings,
  OpenPath,
  OpenWebUI,
  StartServer,
  StopServer,
  Version,
} from '../bindings/github.com/mihaiflorentin88/filelist-streaming-service/internal/gui/bindings';
import { useServerState } from '../lib/state';

// Server page: the status card (the page's one bold element: state line +
// Start/Stop + Open web UI), the Start-at-login card (toggle reflects the OS
// read-back, never memory), and the details row (version, settings file,
// data folder with reveal buttons).
export function ServerPage() {
  const server = useServerState();
  const [version, setVersion] = useState('');
  const [settingsPath, setSettingsPath] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [dataDirSource, setDataDirSource] = useState('');
  // null = not read back yet; the toggle stays disabled until the OS answers.
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  // The Change data folder dialog: open/closed, the entered path, the
  // backend's verbatim refusal (after submit), and the in-flight flag.
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeTarget, setChangeTarget] = useState('');
  const [changeError, setChangeError] = useState('');
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    let alive = true;
    void Version().then(v => { if (alive) setVersion(v) }).catch(() => { });
    void DataDirInfo().then(([dir, source]) => {
      if (!alive) return;
      setDataDir(dir);
      setDataDirSource(source);
    }).catch(() => { });
    void LoadSettings().then(view => { if (alive) setSettingsPath(view.settingsPath) }).catch(() => { });
    void refreshAutostart();
    return () => { alive = false };
  }, []);

  async function refreshAutostart() {
    try {
      const enabled = await AutostartStatus();
      setAutostart(enabled);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleAutostart() {
    setError('');
    try {
      if (autostart) await DisableAutostart();
      else await EnableAutostart();
    } catch (e) {
      setError((e as Error).message);
    }
    // The OS artifact is the source of truth: read it back after any change.
    await refreshAutostart();
  }

  async function run(action: () => Promise<void>) {
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function openChange() {
    setChangeError('');
    setChangeTarget('');
    setChangeOpen(true);
  }

  // Submit calls the backend once; only a resolved change refreshes the
  // path (from a fresh DataDirInfo read — the backend may normalize it).
  // A rejection shows the backend's error verbatim and keeps the dialog
  // open: the move rolled back Go-side, so the user can correct the path.
  async function submitChange() {
    const target = changeTarget.trim();
    if (!target || moving) return;
    setChangeError('');
    setMoving(true);
    try {
      await ChangeDataDir(target);
      const [dir, source] = await DataDirInfo();
      setDataDir(dir);
      setDataDirSource(source);
      setChangeOpen(false);
      setChangeTarget('');
    } catch (e) {
      setChangeError((e as Error).message);
    } finally {
      setMoving(false);
    }
  }


  const transitioning = server.state === 'starting' || server.state === 'stopping';
  const stateLine = server.state === 'running'
    ? `Running on http://${server.address || '127.0.0.1:8097'}`
    : server.state === 'failed' ? `Failed — ${server.error || 'unknown error'}`
      : server.state === 'stopped' ? 'Stopped' : server.state[0].toUpperCase() + server.state.slice(1) + '…';

  return (
    <section class="settings">
      <fieldset>
        <legend>Server</legend>
        <p class="server-state-line">
          <span class={`dot dot-${server.state}`} aria-hidden="true" />
          {stateLine}
        </p>
        <div class="fields">
          {server.state === 'running' || server.state === 'starting'
            ? <button class="primary" type="button" disabled={transitioning} onClick={() => void run(StopServer)}>Stop server</button>
            : <button class="primary" type="button" disabled={transitioning} onClick={() => void run(StartServer)}>Start server</button>}
          <button type="button" disabled={server.state !== 'running'} onClick={() => void run(OpenWebUI)}>Open web UI</button>
        </div>
        {error && <p class="settings-status" role="alert">{error}</p>}
      </fieldset>
      <fieldset>
        <legend>Start at login</legend>
        <label class="switch-field">
          <input
            type="checkbox"
            checked={autostart === true}
            disabled={autostart === null}
            onInput={() => void toggleAutostart()}
          />
          <span class="switch-track" aria-hidden="true"><span class="switch-knob" /></span>
          <span class="switch-copy">Start FileList Streaming when you log in</span>
        </label>
        <p class="supporting">Starts minimized to the tray. The switch always reflects the operating system's launch-on-boot entry.</p>
      </fieldset>
      <fieldset>
        <legend>Details</legend>
        <p class="supporting">Version {version || '…'}</p>
        <p class="supporting">Settings file: {settingsPath || '…'}</p>
        <p class="supporting">
          Data folder: {dataDir || '…'}{dataDirSource ? ` (from ${dataDirSource})` : ''}
          {' '}
          <button type="button" disabled={!dataDir} onClick={() => void run(() => OpenPath('data'))}>Open data folder</button>
          {' '}
          <button type="button" disabled={!dataDir} onClick={() => void run(() => OpenPath('logs'))}>Open logs folder</button>
          {' '}
          <button type="button" disabled={!dataDir} onClick={openChange}>Change…</button>
        </p>
      </fieldset>
      {changeOpen && (
        <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="change-data-dir-heading">
          <section class="removal-confirm">
            <h2 id="change-data-dir-heading">Change data folder</h2>
            <p class="supporting">The server will restart; your data moves to the new location.</p>
            <div class="fields">
              <label>
                New location
                <input
                  value={changeTarget}
                  onInput={e => setChangeTarget(e.currentTarget.value)}
                  placeholder="/absolute/path/for/the/data"
                  aria-label="New data folder path"
                />
              </label>
            </div>
            {changeError && <p class="settings-status" role="alert">{changeError}</p>}
            <div class="confirm-actions">
              <button type="button" disabled={moving} onClick={() => setChangeOpen(false)}>Cancel</button>
              <button type="button" class="primary" disabled={moving || !changeTarget.trim()} onClick={() => void submitChange()}>Move data</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
