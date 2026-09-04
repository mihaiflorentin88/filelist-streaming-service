import { afterEach, describe, expect, it, vi } from 'vitest';

// The bridge is unavailable under vitest; these tests pin the only
// load-bearing part of the wrapper layer: the fully-qualified Go method
// names and positional argument passing. A typo'd FQN silently breaks the
// desktop at runtime, so the exact strings are the contract here.
const calls = vi.hoisted(() => [] as Array<{ method: string; args: unknown[] }>);

vi.mock('@wailsio/runtime', () => ({
  Call: {
    ByName: (name: string, ...args: unknown[]) => {
      calls.push({ method: name, args });
      return Promise.resolve(null);
    },
  },
}));

import { Bindings } from './bindings';

const service = 'github.com/mihaiflorentin88/filelist-streaming-service/internal/gui.Bindings';

describe('bindings wrappers', () => {
  afterEach(() => {
    calls.length = 0;
  });

  it('targets the exact internal/gui.Bindings methods', async () => {
    await Bindings.serverState();
    await Bindings.startServer();
    await Bindings.stopServer();
    await Bindings.restartServer();
    await Bindings.loadSettings();
    await Bindings.settingsSchema();
    await Bindings.missingRequired();
    await Bindings.version();
    await Bindings.autostartStatus();
    await Bindings.enableAutostart();
    await Bindings.disableAutostart();
    await Bindings.dataDirInfo();
    await Bindings.openWebUI();
    await Bindings.quit();
    expect(calls.map(call => call.method)).toEqual([
      `${service}.ServerState`,
      `${service}.StartServer`,
      `${service}.StopServer`,
      `${service}.RestartServer`,
      `${service}.LoadSettings`,
      `${service}.SettingsSchema`,
      `${service}.MissingRequired`,
      `${service}.Version`,
      `${service}.AutostartStatus`,
      `${service}.EnableAutostart`,
      `${service}.DisableAutostart`,
      `${service}.DataDirInfo`,
      `${service}.OpenWebUI`,
      `${service}.Quit`,
    ]);
    expect(calls.every(call => call.args.length === 0)).toBe(true);
  });

  it('passes payloads positionally', async () => {
    const next = { instanceName: 'Renamed', fileListPasskey: '' };
    await Bindings.saveSettings(next);
    await Bindings.openPath('logs');
    expect(calls[0]).toEqual({ method: `${service}.SaveSettings`, args: [next] });
    expect(calls[1]).toEqual({ method: `${service}.OpenPath`, args: ['logs'] });
  });
});
