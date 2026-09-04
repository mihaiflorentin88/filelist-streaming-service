// Thin typed wrappers over the Wails v3 bridge for the internal/gui.Bindings
// service. Every wrapper pins the exact Go method name over Call.ByName —
// the FQN is "<module path>/internal/gui.Bindings.<Method>".
//
// Why hand-written instead of `wails3 generate bindings`: the generator
// discovers services from wails `application.NewService(...)` wiring, which
// lands with the Task 6 runner; the Go module deliberately carries no wails
// dependency yet (it wraps this struct by reflection at runtime), so
// generation today finds zero services. These wrappers are the fallback the
// plan allows; the final review checks signature parity against
// internal/gui/bindings.go.
import { Call } from '@wailsio/runtime';

const service = 'github.com/mihaiflorentin88/filelist-streaming-service/internal/gui.Bindings';

// One optional JSON field per internal/platform/config.Settings key: the Go
// side JSON-decodes the payload into config.Settings and validates it, so
// omitted keys fall back to the stored file values and blank secrets keep
// their stored value.
export type Settings = Partial<{
  instanceName: string;
  listenAddress: string;
  trustedCidrs: string[];
  databasePath: string;
  downloadRoot: string;
  fileListUrl: string;
  fileListUsername: string;
  fileListPasskey: string;
  qbittorrentUrl: string;
  qbittorrentUsername: string;
  qbittorrentPassword: string;
  downloadEngine: string;
  torrentPeerPort: number;
  torrentSessionDir: string;
  initialBufferBytes: number;
  readAheadBytes: number;
  pieceWaitTimeoutSeconds: number;
  streamStartBytes: number;
  catalogMaxAgeHours: number;
  allocationGb: number;
  reserveGb: number;
  evictionRules: string[];
  protectIncomplete: boolean;
  protectLeased: boolean;
  protectFavorites: boolean;
  protectNeverWatched: boolean;
  preferredSubtitleLanguage: string;
  fallbackSubtitleLanguage: string;
  preferredAudioLanguage: string;
  tmdbApiKey: string;
  metadataLanguage: string;
  metadataFallbackLanguage: string;
  artworkCachePath: string;
  artworkCacheMaxBytes: number;
  subDLUrl: string;
  subDLApiKey: string;
  subtitleCachePath: string;
  subtitleCacheMaxBytes: number;
  ffprobePath: string;
  ffmpegPath: string;
  watchedThresholdPercent: number;
  maxConcurrentJobs: number;
  titleRefreshTimeoutMinutes: number;
}>;

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

// Mirrors gui.StateEvent (also the 'server:state' event payload).
export type StateEvent = { state: ServerState; error?: string; address?: string };

// Mirrors httpapi.SettingsView: the settings with secrets blanked, one
// Configured flag per secret, and the settings file path.
export type SettingsView = Settings & {
  fileListPasskeyConfigured: boolean;
  qbittorrentPasswordConfigured: boolean;
  tmdbApiKeyConfigured: boolean;
  subDLApiKeyConfigured: boolean;
  settingsPath: string;
};

// Mirrors httpapi.SchemaField (the /api/v1/settings/schema items).
export type SchemaField = {
  key: string;
  label: string;
  help: string;
  obtain?: string;
  tvVisible: boolean;
  sensitive: boolean;
  restartRequired: boolean;
  readOnly: boolean;
};

// Mirrors gui.SaveResult.
export type SaveResult = { saved: boolean; restartRequired: boolean; autoStarted: boolean };

export type DataDirKind = 'logs' | 'data';

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return (await Call.ByName(`${service}.${method}`, ...args)) as T;
}

export const Bindings = {
  serverState: (): Promise<StateEvent> => call('ServerState'),
  startServer: (): Promise<void> => call('StartServer'),
  stopServer: (): Promise<void> => call('StopServer'),
  restartServer: (): Promise<void> => call('RestartServer'),
  loadSettings: (): Promise<SettingsView> => call('LoadSettings'),
  saveSettings: (next: Settings): Promise<SaveResult> => call('SaveSettings', next),
  settingsSchema: (): Promise<SchemaField[]> => call('SettingsSchema'),
  missingRequired: (): Promise<string[]> => call('MissingRequired'),
  version: (): Promise<string> => call('Version'),
  autostartStatus: (): Promise<boolean> => call('AutostartStatus'),
  enableAutostart: (): Promise<void> => call('EnableAutostart'),
  disableAutostart: (): Promise<void> => call('DisableAutostart'),
  // DataDirInfo returns (dir, source): the bridge carries the two strings
  // as an array.
  dataDirInfo: (): Promise<[string, string]> => call('DataDirInfo'),
  openPath: (kind: DataDirKind): Promise<void> => call('OpenPath', kind),
  openWebUI: (): Promise<void> => call('OpenWebUI'),
  quit: (): Promise<void> => call('Quit'),
};
