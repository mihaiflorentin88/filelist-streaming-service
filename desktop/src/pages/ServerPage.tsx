import { useEffect, useState } from 'preact/hooks';
import { Bindings } from '../lib/bindings';
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

  useEffect(() => {
    let alive = true;
    void Bindings.version().then(v => { if (alive) setVersion(v) }).catch(() => { });
    void Bindings.dataDirInfo().then(([dir, source]) => {
      if (!alive) return;
      setDataDir(dir);
      setDataDirSource(source);
    }).catch(() => { });
    void Bindings.loadSettings().then(view => { if (alive) setSettingsPath(view.settingsPath) }).catch(() => { });
    void refreshAutostart();
    return () => { alive = false };
  }, []);

  async function refreshAutostart() {
    try {
      const enabled = await Bindings.autostartStatus();
      setAutostart(enabled);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleAutostart() {
    setError('');
    try {
      if (autostart) await Bindings.disableAutostart();
      else await Bindings.enableAutostart();
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
            ? <button class="primary" type="button" disabled={transitioning} onClick={() => void run(Bindings.stopServer)}>Stop server</button>
            : <button class="primary" type="button" disabled={transitioning} onClick={() => void run(Bindings.startServer)}>Start server</button>}
          <button type="button" disabled={server.state !== 'running'} onClick={() => void run(Bindings.openWebUI)}>Open web UI</button>
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
          <button type="button" disabled={!dataDir} onClick={() => void run(() => Bindings.openPath('data'))}>Open data folder</button>
          {' '}
          <button type="button" disabled={!dataDir} onClick={() => void run(() => Bindings.openPath('logs'))}>Open logs folder</button>
        </p>
      </fieldset>
    </section>
  );
}
