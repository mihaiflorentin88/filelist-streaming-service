// Shared, framework-free persisted player settings: the browser player stores
// volume and mute per browser (localStorage) and reloads them on every mount,
// so chosen loudness survives across videos and browser restarts. Storage is
// injected — browsers pass localStorage, tests pass a plain object — and
// absent or corrupt entries fall back to the defaults (100%, unmuted) instead
// of breaking playback.
export interface PlayerSettings { volume: number; muted: boolean }
export interface PlayerSettingsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const PLAYER_VOLUME_KEY = 'filelist.player.volume';
export const PLAYER_MUTED_KEY = 'filelist.player.muted';
export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = { volume: 1, muted: false };
// The slider deals in 0..1; anything unparseable (absent key, corrupt entry) falls back to the default rather than silencing playback.
export function clampVolume(value: unknown): number { const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN; return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : DEFAULT_PLAYER_SETTINGS.volume }
export function loadPlayerSettings(storage: PlayerSettingsStorage): PlayerSettings { return { volume: clampVolume(storage.getItem(PLAYER_VOLUME_KEY)), muted: storage.getItem(PLAYER_MUTED_KEY) === 'true' } }
// Persistence is best-effort: a blocked or full store (private mode, quota) must never take playback down with it.
export function savePlayerSettings(storage: PlayerSettingsStorage, settings: PlayerSettings): void { try { storage.setItem(PLAYER_VOLUME_KEY, String(clampVolume(settings.volume))); storage.setItem(PLAYER_MUTED_KEY, String(Boolean(settings.muted))) } catch { } }
