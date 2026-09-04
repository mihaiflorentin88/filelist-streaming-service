import { useEffect, useState } from 'preact/hooks';
import { Settings } from '@filelist/web/settings';
import { Bindings, type SchemaField, type SettingsView } from '../lib/bindings';
import { useServerState } from '../lib/state';

// Settings page: the shared web Settings component fed by the bindings
// transport. LoadSettings/SettingsSchema work with the server stopped; the
// Test and Maintenance tabs (and the component's save) talk HTTP to the live
// server, so a stopped server gets the explanatory note above the form. A
// save that changes restart-required fields surfaces the inline "Restart to
// apply" action; a save that completes the required settings auto-starts the
// server (Go side) and clears the missing-settings banner.
export function SettingsPage() {
  const server = useServerState();
  const [value, setValue] = useState<SettingsView | null>(null);
  const [fields, setFields] = useState<SchemaField[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [restartRequired, setRestartRequired] = useState(false);
  // Bumped when a deep-link needs the shared component to remount so its
  // tab re-initializes from the URL hash.
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [view, schema, missingKeys] = await Promise.all([
          Bindings.loadSettings(),
          Bindings.settingsSchema(),
          Bindings.missingRequired().catch(() => [] as string[]),
        ]);
        if (!alive) return;
        setValue(view);
        setFields(schema);
        setMissing(missingKeys);
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    })();
    return () => { alive = false };
  }, []);

  // The shared component saved over HTTP; mirror the save through the
  // bindings so the Go store answers for it (restart diff + auto-start).
  async function onSaved(saved: Record<string, unknown>) {
    setSaveError('');
    try {
      const result = await Bindings.saveSettings(saved);
      setRestartRequired(result.restartRequired);
      setMissing(await Bindings.missingRequired().catch(() => [] as string[]));
      setValue(current => (current ? { ...current, ...saved } as SettingsView : current));
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  function focusTracker() {
    // The shared component reads its initial tab from the URL hash.
    history.replaceState(null, '', '#tracker');
    setFormKey(key => key + 1);
  }

  async function restart() {
    setSaveError('');
    try {
      await Bindings.restartServer();
      setRestartRequired(false);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  return (
    <section class="desktop-settings">
      {missing.length > 0 && (
        <p class="settings-status" role="alert">
          Required settings missing: {missing.join(', ')}. The server cannot start without them.
          {' '}
          <button type="button" onClick={focusTracker}>Set them in the Tracker tab</button>
        </p>
      )}
      {saveError && <p class="settings-status" role="alert">{saveError}</p>}
      {restartRequired && (
        <p class="settings-status">
          Settings saved. Restart the server to apply the changed core settings.
          {' '}
          <button class="primary" type="button" onClick={() => void restart()}>Restart to apply</button>
        </p>
      )}
      {server.state !== 'running' && (
        <p class="supporting" role="note">
          The server is {server.state}. Start the server to run tests — the Test and Maintenance tabs talk to the
          live server and show their own errors until it runs. Settings are read from disk either way.
        </p>
      )}
      {loadError
        ? <p class="settings-status" role="alert">Could not load settings: {loadError}</p>
        : value
          ? <Settings
            key={formKey}
            value={value as Record<string, unknown>}
            fields={fields}
            onSaved={saved => void onSaved(saved)}
            onError={message => setSaveError(message)}
          />
          : <p class="supporting">Loading settings…</p>}
    </section>
  );
}
