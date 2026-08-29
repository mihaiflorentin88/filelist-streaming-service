import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { API, audioPlaybackRoute, buildPath, canonicalHouseholdItems, CatalogDetail, CatalogSource, CatalogTitle, clampVolume, ControlsVisibility, Download, DownloadSort, formatBytes, HouseholdItem, HouseholdState, Job, JobLog, languageDisplayName, LibraryCategory, loadPlayerSettings, logicalPlaybackPosition, MediaAudioTrack, MediaInfo, MediaState, canonicalLanguage, subtitleRank, orderDownloadIDs, parsePath, PlaybackPreferences, PlayerSettingsStorage, preferredAudioTrack, reconcileDownloads, Route, resumeActionLabel, resumeForTitle, resumeSummary, savePlayerSettings, seasonPackActionLabel, SettingsField, SubtitleCandidate, subtitleItemLabel, subtitleMenuGroups, SubtitleWarning, View } from '@filelist/shared';
import './style.css';

const api = new API(location.origin);
type ActivePlayer = { download: Download; resumeMs: number; preferences?: PlaybackPreferences };
type DetailTarget = { season?: number; episode?: number };
// The address bar mirrors the view: sidebar navigation pushes an entry,
// search submissions replace in place, and popstate restores from the URL.
function pushRoute(route: Route) { const url = buildPath(route); if (location.pathname + location.search !== url) window.history.pushState({}, '', url) }
function replaceRoute(route: Route) { const url = buildPath(route); if (location.pathname + location.search !== url) window.history.replaceState({}, '', url) }
const emptyState: HouseholdState = { favorites: [], continueWatching: [], recent: [], watched: [] };
const needsEpisodeExpansion = (detail: CatalogDetail) => detail.title.kind === 'series' && detail.seasons.some(season => (season.packSources?.length || 0) > 0 && season.episodes.length === 0);
function formatPlaybackTime(milliseconds: number) { const total = Math.max(0, Math.floor(milliseconds / 1000)); const hours = Math.floor(total / 3600); const minutes = Math.floor(total % 3600 / 60); const seconds = total % 60; return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}` }
function audioTrackLabel(track: MediaAudioTrack) { const language = languageDisplayName(track.language || '') || track.language?.toUpperCase() || 'Language unavailable'; const channels = track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Stereo' : track.channels && track.channels > 2 ? `${track.channels} channels` : ''; return [track.title, language, track.codec?.toUpperCase(), channels].filter(Boolean).join(' · ') }
// The compatibility stream is a live ffmpeg transcode (video copied, audio
// converted to AAC) served as fragmented MP4. It exists for codecs the
// browser cannot decode (E-AC-3 in most releases). A live transcode is not
// range-addressable, so seeking re-issues the request at the new position.
export function browserPlaybackURL(download: Download, audioTrack = -1, startMs = 0, snapped = false) {
  if (!download.browserStreamUrl) return download.streamUrl;
  const value = new URL(download.browserStreamUrl, location.origin);
  if (audioTrack >= 0) value.searchParams.set('audioTrack', String(audioTrack));
  if (startMs > 0) value.searchParams.set('startMs', String(Math.round(startMs)));
  // startMs is already a keyframe: the server skips its own probe.
  if (snapped) value.searchParams.set('snapped', '1');
  return `${value.pathname}${value.search}`;
}
// Storage access itself can throw or be missing (blocked cookies, odd embeds,
// non-browser runs); the player then runs with defaults and no persistence
// instead of crashing.
function persistedStore(): PlayerSettingsStorage { try { const store = localStorage; if (store) return store } catch { } return { getItem: () => null, setItem: () => { } } }
function permanentPersistenceFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  return error.status === 404 || error.status === 409;
}
const MAX_RECOVER_ATTEMPTS = 3;
const navGroups: { label?: string; items: { id: View; label: string; icon: string }[] }[] = [
  { items: [{ id: 'home', label: 'Home', icon: 'home' }, { id: 'search', label: 'Search', icon: 'search' }] },
  { label: 'My Library', items: [{ id: 'library', label: 'Dashboard', icon: 'library' }, { id: 'continue', label: 'Continue watching', icon: 'play' }, { id: 'favorites', label: 'Favorites', icon: 'heart' }, { id: 'watched', label: 'Watched', icon: 'check' }, { id: 'downloads', label: 'Downloads', icon: 'download' }, { id: 'library-categories', label: 'Categories', icon: 'folder' }] },
  { label: 'Tracker', items: [{ id: 'tracker', label: 'Dashboard', icon: 'tracker' }, { id: 'browse', label: 'Browse', icon: 'grid' }, { id: 'categories', label: 'Categories', icon: 'folder' }] },
  { items: [{ id: 'jobs', label: 'Jobs', icon: 'activity' }, { id: 'events', label: 'Events', icon: 'tracker' }, { id: 'settings', label: 'Settings', icon: 'settings' }] },
];

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { home: 'M3 11.5 12 4l9 7.5V21h-6v-6H9v6H3z', search: 'M10.5 4a6.5 6.5 0 1 0 4.1 11.55L20 21l1-1-5.45-5.4A6.5 6.5 0 0 0 10.5 4z', library: 'M4 5h16v14H4zM8 5v14', play: 'M8 5v14l11-7z', heart: 'M12 21S4 16 4 9.5C4 5 9.5 3 12 7c2.5-4 8-2 8 2.5C20 16 12 21 12 21z', check: 'm5 12 4 4L19 6', download: 'M12 3v12m-5-5 5 5 5-5M4 21h16', tracker: 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 11a1 1 0 1 0 1 1', grid: 'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z', clock: 'M12 3a9 9 0 1 0 9 9h-9V6', folder: 'M3 6h7l2 2h9v11H3z', activity: 'M3 12h4l2-6 4 12 2-6h6', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4' };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] || paths.grid} /></svg>;
}

function Sidebar({ view, onView }: { view: View; onView: (view: View) => void }) {
  return <aside class="sidebar"><div class="brand"><span class="brand-mark">FL</span><strong>FileList <span>Streaming</span></strong></div><nav aria-label="Main navigation">{navGroups.map((group, index) => <div class="nav-group" key={index}>{group.label && <p>{group.label}</p>}{group.items.map(item => <button class={view === item.id ? 'selected' : ''} onClick={() => onView(item.id)} aria-current={view === item.id ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>)}</nav></aside>;
}

function Artwork({ title, kind = 'poster' }: { title: CatalogTitle; kind?: 'poster' | 'backdrop' }) {
  const url = kind === 'poster' ? title.posterUrl : title.backdropUrl;
  return url ? <img src={url} alt="" loading="lazy" /> : <div class="art-fallback"><span>{title.title.slice(0, 1).toUpperCase()}</span></div>;
}

function MediaCard({ title, onOpen, wide = false, progress }: { title: CatalogTitle; onOpen: (title: CatalogTitle) => void; wide?: boolean; progress?: number }) {
  return <button class={`media-card ${wide ? 'wide' : ''}`} onClick={() => onOpen(title)} aria-label={`Open ${title.title}`}><div class="card-art"><Artwork title={title} kind={wide ? 'backdrop' : 'poster'} />{title.ratingVotes ? <span class="rating-badge">★ {title.rating?.toFixed(1)}</span> : null}<MediaBadges state={title.libraryState} />{progress !== undefined && <span class="card-progress"><i style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></span>}</div><span class="card-copy"><strong>{title.title}</strong><small>{[title.year || '', title.resolutions[0] || '', title.ratingVotes ? `★ ${title.rating?.toFixed(1)}` : '', `${title.bestSeeders} seeds`].filter(Boolean).join(' · ')}</small></span></button>;
}

function LegacyCard({ item, onOpen }: { item: HouseholdItem; onOpen: (item: HouseholdItem) => void }) {
  if (item.catalog) { const progress = item.durationMs > 0 ? Math.max(0, Math.min(100, item.positionMs / item.durationMs * 100)) : 0; return <button class="media-card wide library-card" onClick={() => onOpen(item)} aria-label={`Open ${item.catalog.title}`}><div class="card-art"><Artwork title={item.catalog} kind="backdrop" /><MediaBadges state={item.catalog.libraryState} />{item.positionMs > 0 && <span class="card-progress"><i style={{ width: `${progress}%` }} /></span>}</div><span class="card-copy"><strong>{item.catalog.title}</strong><small>{[item.catalog.year, item.catalog.resolutions[0], item.watched ? 'Watched' : item.positionMs > 0 ? `${Math.round(progress)}% watched` : 'View details'].filter(Boolean).join(' · ')}</small><small class="library-card-release">{item.seasonNumber && item.episodeNumber ? `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')} · ` : ''}{item.filePath || item.release.name}</small></span></button> }
  return <button class="media-card wide raw" onClick={() => onOpen(item)}><div class="art-fallback"><span>{item.release.name.slice(0, 1)}</span></div><span class="card-copy"><strong>{item.release.name}</strong><small>{formatBytes(item.release.sizeBytes)} · View details</small></span></button>;
}

function MediaBadges({ state }: { state?: MediaState }) { if (!state?.downloadState || !state.watchState) return null; const download = state.downloadState; const watch = state.watchState; return <span class="media-badges">{download !== 'none' && <span class={`media-badge download ${download}`} title={download === 'downloaded' ? 'Downloaded' : download === 'partial' ? 'Some episodes downloaded' : download === 'error' ? 'Download needs attention' : `Downloading ${Math.round((state.progress || 0) * 100)}%`}><Icon name={download === 'downloaded' ? 'check' : 'download'} /><span>{download === 'downloaded' ? 'Downloaded' : download === 'partial' ? 'Partial' : download === 'error' ? 'Error' : `${Math.round((state.progress || 0) * 100)}%`}</span></span>}{watch !== 'unwatched' && <span class={`media-badge watch ${watch}`} title={watch === 'watched' ? 'Watched' : watch === 'partial' ? 'Some episodes watched' : 'In progress'}><Icon name="check" /><span>{watch === 'watched' ? 'Watched' : watch === 'partial' ? 'Part watched' : 'In progress'}</span></span>}</span> }

type ViewportAnchor = { id: string; top: number };
function captureDownloadAnchor(): ViewportAnchor | null { const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-download-id]')); const row = rows.find(item => item.getBoundingClientRect().bottom > 0); return row ? { id: row.dataset.downloadId || '', top: row.getBoundingClientRect().top } : null }
function restoreDownloadAnchor(anchor: ViewportAnchor | null) { if (!anchor) return; const row = document.querySelector<HTMLElement>(`[data-download-id="${CSS.escape(anchor.id)}"]`); if (!row) return; const delta = row.getBoundingClientRect().top - anchor.top; if (Math.abs(delta) > 0.5) window.scrollBy(0, delta) }

function Rail({ title, children, empty, landscape = false }: { title: string; children: any; empty?: string; landscape?: boolean }) { const list = Array.isArray(children) ? children.filter(Boolean) : children; return <section class="rail-section"><div class="section-heading"><h2>{title}</h2></div>{(!list || list.length === 0) ? <p class="empty">{empty || 'Nothing here yet.'}</p> : <div class={`rail ${landscape ? 'landscape' : ''}`}>{list}</div>}</section> }

function useModalFocus(root: { current: HTMLElement | null }, onClose: () => void) { useEffect(() => { const previous = document.activeElement as HTMLElement | null; const background = Array.from(document.querySelectorAll<HTMLElement>('.sidebar,.content')); background.forEach(element => element.setAttribute('inert', '')); const focusable = () => Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])') || []); const timer = window.setTimeout(() => focusable()[0]?.focus(), 0); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); return } if (event.key !== 'Tab') return; const items = focusable(); if (items.length === 0) return; const index = items.indexOf(document.activeElement as HTMLElement); event.preventDefault(); items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus() }; document.addEventListener('keydown', key); return () => { window.clearTimeout(timer); document.removeEventListener('keydown', key); background.forEach(element => element.removeAttribute('inert')); previous?.focus() }; }, []) }
function useOverlayFocus(active: boolean, onClose: () => void) { useEffect(() => { if (!active) return; const root = { get current() { const overlays = document.querySelectorAll<HTMLElement>('.overlay'); return overlays[overlays.length - 1] || null } }; const previous = document.activeElement as HTMLElement | null; const overlay = root.current; const background = Array.from(document.querySelectorAll<HTMLElement>('.sidebar,.content')).filter(element => !overlay || !element.contains(overlay)); background.forEach(element => element.setAttribute('inert', '')); const focusable = () => Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])') || []); const timer = window.setTimeout(() => focusable()[0]?.focus(), 0); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); return } if (event.key !== 'Tab') return; const items = focusable(); if (!items.length) return; const index = items.indexOf(document.activeElement as HTMLElement); event.preventDefault(); items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus() }; document.addEventListener('keydown', key); return () => { window.clearTimeout(timer); document.removeEventListener('keydown', key); background.forEach(element => element.removeAttribute('inert')); previous?.focus() }; }, [active]) }

export function BrowserPlayer({ active, onClose, onStateChanged, onAdvance }: { active: ActivePlayer; onClose: () => void; onStateChanged: () => void; onAdvance: (preferences: PlaybackPreferences) => Promise<void> }) {
  const defaults: PlaybackPreferences = { audioLanguage: 'en', audioTrackIndex: -1, subtitleLanguage: 'ro', subtitleMode: 'auto' };
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const lastSaved = useRef(0);
  const lastRendered = useRef(0);
  const retryTimer = useRef(0);
  const mediaRetryTimer = useRef(0);
  const recovering = useRef(false);
  const recoverAttempts = useRef(0);
  const saveFailed = useRef(false);
  const shouldPlay = useRef(true);
  const preferenceRef = useRef<PlaybackPreferences>(active.preferences || defaults);
  const durationRef = useRef(0);
  const [message, setMessage] = useState('Reading media details…');
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [selectedAudio, setSelectedAudio] = useState(-1);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Volume and mute persist per browser (localStorage): loaded once per mount,
  // saved on every change, applied to whichever audio route is active.
  const [volume, setVolume] = useState(() => loadPlayerSettings(persistedStore()).volume);
  const [muted, setMuted] = useState(() => loadPlayerSettings(persistedStore()).muted);
  const [candidates, setCandidates] = useState<SubtitleCandidate[]>([]);
  const [warnings, setWarnings] = useState<SubtitleWarning[]>([]);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  // Content position at the head of the current compatibility stream. The
  // element's clock starts at zero for that request, so the logical position
  // is offset + element.currentTime (see logicalPlaybackPosition).
  const offsetRef = useRef(0);
  // Whether offsetRef holds a probed keyframe; forwards snapped=1 so the
  // stream route skips its own probe.
  const snappedRef = useRef(false);
  const [streamOffset, setStreamOffset] = useState(0);
  // True while a compatibility re-request is in flight; suppresses buffering
  // chatter and recovery for the reload window.
  const reloading = useRef(false);
  // Original VTT cue times so offset re-syncs shift from truth, not drift.
  const cueTimes = useRef(new Map<TextTrackCue, { start: number; end: number }>());
  // Pending element seek applied on the next loadedmetadata (track switches
  // that move between native and compatibility routes).
  const pendingSeekRef = useRef(-1);
  const [selectedSubtitle, setSelectedSubtitle] = useState('off');
  const [controlsVisible, setControlsVisible] = useState(true);
  const controls = useMemo(() => new ControlsVisibility({ policy: { armWhilePaused: true, statusHolds: true, manualHideSuppressionMs: 500 }, onChange: setControlsVisible }), []);
  controls.setStatus(message !== '');
  controls.setPanelOpen(subtitleOpen || audioOpen);
  useModalFocus(root, onClose);

  const currentTrack = mediaInfo?.audioTracks.find(track => track.streamIndex === selectedAudio);
  const browserMode = !!currentTrack && !!mediaInfo && (audioPlaybackRoute(currentTrack.codec) === 'decode' || (mediaInfo.audioTracks.length > 1 && !currentTrack.default));
  const playbackURL = useMemo(() => {
    if (!mediaInfo) return '';
    if (browserMode) return browserPlaybackURL(active.download, selectedAudio, streamOffset, snappedRef.current);
    return active.download.streamUrl;
  }, [active.download.id, mediaInfo, browserMode, selectedAudio, streamOffset]);
  const subtitlePositions = useMemo(() => new Map(candidates.map((candidate, index) => [candidate, index + 1])), [candidates]);
  const subtitleGroups = useMemo(() => subtitleMenuGroups(candidates), [candidates]);
  const save = async () => {
    if (durationRef.current <= 0 || saveFailed.current) return;
    try {
      await api.updatePlayback(active.download.id, logicalPlaybackPosition(offsetRef.current, video.current?.currentTime || 0, durationRef.current), durationRef.current);
      onStateChanged()
    } catch (error) {
      // Position persistence is best-effort: a missing source (404) or a permanent
      // update conflict (409) ends it for this playback instead of hammering the
      // endpoint every ten seconds; transient failures keep the 10s cadence.
      if (permanentPersistenceFailure(error)) saveFailed.current = true;
    }
  };
  const savePreferences = async (value: PlaybackPreferences) => { preferenceRef.current = value; try { preferenceRef.current = await api.updatePlaybackPreferences(active.download.id, value) } catch { } };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [saved, info] = await Promise.all([active.preferences ? Promise.resolve(active.preferences) : api.playbackPreferences(active.download.id).catch(() => defaults), api.mediaInfo(active.download.id)]);
        if (cancelled) return;
        preferenceRef.current = saved;
        recoverAttempts.current = 0;
        saveFailed.current = false;
        durationRef.current = info.durationMs;
        const track = preferredAudioTrack(info.audioTracks, saved);
        const initial = Math.min(Math.max(0, active.resumeMs), Math.max(0, info.durationMs - 1000));
        setMediaInfo(info);
        setPosition(initial);
        const chosen = track;
        const useBrowser = !!chosen && (audioPlaybackRoute(chosen.codec) === 'decode' || (info.audioTracks.length > 1 && !chosen.default));
        offsetRef.current = 0;
        snappedRef.current = false;
        if (useBrowser && initial > 0) {
          // The route snaps seeks onto a video keyframe; clock and subtitle
          // offsets must use that effective start, not the requested one.
          try { const snap = await api.snapStreamStart(active.download.id, initial); offsetRef.current = snap.startMs; snappedRef.current = snap.snapped } catch { offsetRef.current = initial }
        }
        setStreamOffset(offsetRef.current);
        setSelectedAudio(track?.streamIndex ?? -1);
        setMessage('Opening stream…');
      } catch (error) {
        if (cancelled) return;
        setMessage(`Preparing media details… ${(error as Error).message}`);
        mediaRetryTimer.current = window.setTimeout(() => void load(), 2000);
      }
    }
    void load();
    return () => { cancelled = true; window.clearTimeout(mediaRetryTimer.current) };
  }, [active.download.id]);

  useEffect(() => () => { window.clearTimeout(retryTimer.current); void save() }, [active.download.id]);
  // Subtitle cues carry content-time timestamps; the compatibility stream's
  // element clock starts at the requested offset, so shift cues to match.
  function syncSubtitleOffset(offset: number) {
    video.current?.querySelectorAll<HTMLTrackElement>('track[data-filelist]').forEach(element => {
      for (const cue of Array.from(element.track?.cues || [])) {
        let original = cueTimes.current.get(cue);
        if (!original) { original = { start: cue.startTime, end: cue.endTime }; cueTimes.current.set(cue, original) }
        cue.startTime = Math.max(0, original.start - offset / 1000);
        cue.endTime = Math.max(cue.startTime + .01, original.end - offset / 1000);
      }
    });
  }

  // Loudness truth lives in persisted React state; this effect pushes it to
  // whichever output owns audio — the decoder gain during a decode session,
  // the element otherwise. The element's muted flag while decoding is the
  // controller's implementation detail and is never mirrored back into the
  // UI (that mirror used to show 0 while the decoder played at full gain).
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.volume = volume; element.muted = muted;
  }, [volume, muted]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = active.preferences || await api.playbackPreferences(active.download.id);
        if (cancelled) return;
        preferenceRef.current = saved;
        const page = await api.subtitles(active.download.id, saved.subtitleLanguage || 'ro', 'all');
        if (cancelled) return;
        setCandidates(page.items); setWarnings(page.warnings || []);
        if (saved.subtitleMode === 'off') { disableSubtitles(false); return }
        if (saved.subtitleMode === 'selected' && saved.subtitleProvider && saved.subtitleCandidateId) {
          const remembered = page.items.find(candidate => candidate.provider === saved.subtitleProvider && candidate.id === saved.subtitleCandidateId);
          if (remembered && await chooseSubtitle(remembered, true, false)) return;
        }
        const preferred = [...page.items].sort((a, b) => subtitleRank(a.language, preferenceRef.current.subtitleLanguage || 'ro') - subtitleRank(b.language, preferenceRef.current.subtitleLanguage || 'ro'));
        for (const candidate of preferred) if (await chooseSubtitle(candidate, true, true)) return;
        setMessage((page.warnings || []).map(w => `${w.provider}: ${w.message}`).join(' · ') || 'No Romanian or English subtitle was found.');
      } catch (error) { if (!cancelled) setMessage(`Subtitles unavailable: ${(error as Error).message}`) }
    })();
    return () => { cancelled = true };
  }, [active.download.id]);
  // Player chrome auto-hide: the shared controller holds controls while a panel
  // or a status message is shown; otherwise 2 idle seconds hide them until the
  // next mouse move or key press, windowed and fullscreen alike.
  useEffect(() => {
    if (controlsVisible) controls.refresh();
    return () => controls.dispose();
  }, [controlsVisible, subtitleOpen, audioOpen, message, controls]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.addEventListener('mousemove', revealControls);
    element.addEventListener('keydown', revealControls);
    return () => { element.removeEventListener('mousemove', revealControls); element.removeEventListener('keydown', revealControls) };
  }, []);

  async function chooseSubtitle(candidate: SubtitleCandidate, automatic = false, persist = true) {
    try {
      setMessage(automatic ? 'Selecting subtitles…' : 'Preparing subtitle…');
      const asset = await api.prepareSubtitle(active.download.id, candidate.provider, candidate.id, 'vtt');
      const element = document.createElement('track');
      element.kind = 'subtitles'; element.label = candidate.title || candidate.language || 'Subtitle'; element.srclang = candidate.language || 'und'; element.src = api.streamURL(asset.url); element.default = true; element.dataset.filelist = 'true';
      video.current?.querySelectorAll('track[data-filelist]').forEach(track => track.remove()); video.current?.appendChild(element);
      element.addEventListener('load', () => { if (element.track) { syncSubtitleOffset(offsetRef.current); element.track.mode = 'showing' } setSelectedSubtitle(`${candidate.provider}:${candidate.id}`); setMessage('') }, { once: true });
      element.addEventListener('error', () => setMessage('The subtitle is cached, but this browser could not load it.'), { once: true });
      setSubtitleOpen(false);
      if (persist) await savePreferences({ ...preferenceRef.current, subtitleLanguage: candidate.language || 'en', subtitleProvider: candidate.provider, subtitleCandidateId: candidate.id, subtitleMode: 'selected' });
      return true;
    } catch (error) { if (!automatic) setMessage(`Subtitle failed: ${(error as Error).message}`); return false }
  }
  function disableSubtitles(persist = true) { if (video.current) Array.from(video.current.textTracks).forEach(track => track.mode = 'disabled'); setSelectedSubtitle('off'); setSubtitleOpen(false); if (persist) void savePreferences({ ...preferenceRef.current, subtitleMode: 'off', subtitleProvider: '', subtitleCandidateId: '' }) }
  // Playback recovery retries are bounded: after MAX_RECOVER_ATTEMPTS consecutive
  // failures the loop stops and the viewer sees a terminal message instead of the
  // player reloading the stream every two seconds forever.
  async function recover() {
    if (recovering.current || reloading.current) return;
    recovering.current = true;
    setMessage('Waiting for the next downloaded segment…');
    retryTimer.current = window.setTimeout(async () => {
      try {
        const latest = (await api.downloads()).items.find(item => item.id === active.download.id);
        if (!latest) throw new Error('The download is no longer managed.');
        setMessage(latest.playbackMode === 'progressive' ? `Streaming while downloading · ${Math.round(latest.progress * 100)}%` : 'Downloaded file ready · retrying playback…');
        video.current?.load();
        await video.current?.play();
        recovering.current = false
      } catch (error) {
        recovering.current = false;
        recoverAttempts.current++;
        const detail = `Playback retry failed: ${(error as Error).message}`;
        if (recoverAttempts.current >= MAX_RECOVER_ATTEMPTS) { setMessage(`${detail} This stream is no longer available.`); return }
        setMessage(detail);
        void recover()
      }
    }, 2000)
  }
  async function restartAt(value: number) {
    if (!mediaInfo || !video.current) return;
    const target = Math.min(Math.max(0, value), Math.max(0, mediaInfo.durationMs - 1000));
    if (!browserMode) { video.current.currentTime = target / 1000; setPosition(target); return }
    reloading.current = true;
    let start = target;
    let snapped = false;
    try { const snap = await api.snapStreamStart(active.download.id, target); start = snap.startMs; snapped = snap.snapped } catch { }
    offsetRef.current = start;
    snappedRef.current = snapped;
    syncSubtitleOffset(start);
    setPosition(start);
    setStreamOffset(start);
  }
  async function chooseAudio(track: MediaAudioTrack) {
    if (!mediaInfo) return;
    const nextBrowser = audioPlaybackRoute(track.codec) === 'decode' || (mediaInfo.audioTracks.length > 1 && !track.default);
    if (nextBrowser || browserMode) {
      const target = logicalPlaybackPosition(offsetRef.current, video.current?.currentTime || 0, durationRef.current);
      if (nextBrowser) {
        let start = target;
        let snapped = false;
        try { const snap = await api.snapStreamStart(active.download.id, target); start = snap.startMs; snapped = snap.snapped } catch { }
        offsetRef.current = start;
        snappedRef.current = snapped;
      } else {
        offsetRef.current = 0;
        snappedRef.current = false;
      }
      pendingSeekRef.current = nextBrowser ? -1 : target;
      setStreamOffset(offsetRef.current);
    }
    setSelectedAudio(track.streamIndex);
    setAudioOpen(false);
    await savePreferences({ ...preferenceRef.current, audioTrackIndex: track.streamIndex, audioLanguage: track.language || 'en' });
  }
  function togglePlayback() { const element = video.current; if (!element) return; if (element.paused) { shouldPlay.current = true; void element.play().catch(error => setMessage(`Playback could not start: ${error.message}`)) } else { shouldPlay.current = false; element.pause() } }
  function revealControls() { controls.reveal() }
  function hideControls() { controls.hide() }
  // Loudness changes update persisted React state; the sync effect pushes them
  // to the decoder or the element, and the browser store keeps them for the
  // next mount. Sliding to zero mutes, sliding up from zero unmutes.
  function setPlayerVolume(value: number) { const next = clampVolume(value); setVolume(next); setMuted(next === 0); savePlayerSettings(persistedStore(), { volume: next, muted: next === 0 }) }
  function toggleMuted() { setMuted(!muted); savePlayerSettings(persistedStore(), { volume, muted: !muted }) }
  async function toggleFullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.current?.requestFullscreen() } catch (error) { setMessage(`Fullscreen unavailable: ${(error as Error).message}`) } }
  return <div ref={root} class={`video ${controlsVisible ? 'controls-visible' : ''}`} role="dialog" aria-modal="true" aria-label={`Playing ${active.download.displayTitle || active.download.filePath}`}>
    <video ref={video} src={playbackURL ? api.streamURL(playbackURL) : undefined} autoplay playsInline onLoadedMetadata={event => { reloading.current = false; const pending = pendingSeekRef.current >= 0 ? pendingSeekRef.current : (!browserMode && active.resumeMs > 0 ? active.resumeMs : -1); pendingSeekRef.current = -1; if (pending > 0) event.currentTarget.currentTime = pending / 1000; if (shouldPlay.current) void event.currentTarget.play().catch(() => setMessage('Press Play to start playback.')) }} onWaiting={() => { if (!reloading.current) setMessage(active.download.playbackMode === 'progressive' ? 'Buffering the next downloaded segment…' : 'Buffering…') }} onCanPlay={() => { recovering.current = false; recoverAttempts.current = 0; if (!reloading.current) setMessage('') }} onPlaying={() => { recovering.current = false; recoverAttempts.current = 0; setPlaying(true); if (!reloading.current) setMessage('') }} onTimeUpdate={event => { const next = logicalPlaybackPosition(offsetRef.current, event.currentTarget.currentTime, durationRef.current); const now = Date.now(); if (now - lastRendered.current >= 250) { lastRendered.current = now; setPosition(next) } if (now - lastSaved.current > 10000) { lastSaved.current = now; void save() } }} onPause={() => { setPlaying(false); void save() }} onEnded={() => void save().then(() => onAdvance(preferenceRef.current))} onError={() => void recover()} />
    <div class="player-chrome">
      <div class="player-heading"><strong>{active.download.displayTitle || active.download.filePath}</strong><span>{active.download.playbackMode === 'progressive' ? 'Streaming while downloading' : 'Downloaded file'}</span></div>
      <div class="player-scrubber"><input aria-label="Playback position" type="range" min="0" max={mediaInfo?.durationMs || 1} step="1000" value={Math.min(position, mediaInfo?.durationMs || 1)} disabled={!mediaInfo} onInput={event => setPosition(Number(event.currentTarget.value))} onChange={event => restartAt(Number(event.currentTarget.value))} /><div><time>{formatPlaybackTime(position)}</time><time>{mediaInfo ? formatPlaybackTime(mediaInfo.durationMs) : 'Preparing…'}</time></div></div>
      <div class="player-control-row"><button class="player-play" onClick={togglePlayback}>{playing ? 'Pause' : 'Play'}</button><button onClick={() => restartAt(position - 10000)} disabled={!mediaInfo}>−10 seconds</button><button onClick={() => restartAt(position + 10000)} disabled={!mediaInfo}>+10 seconds</button><label class="player-volume"><span>Volume</span><input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onInput={event => setPlayerVolume(Number(event.currentTarget.value))} /></label><button onClick={toggleMuted}>{muted ? 'Unmute' : 'Mute'}</button><button onClick={() => { setSubtitleOpen(false); setAudioOpen(value => !value); revealControls() }} disabled={!mediaInfo}>Audio{currentTrack ? ` · ${audioTrackLabel(currentTrack).split(' · ')[0]}` : ''}</button><button onClick={() => { setAudioOpen(false); setSubtitleOpen(value => !value); revealControls() }}>Subtitles{selectedSubtitle === 'off' ? ' · Off' : ''}</button><button onClick={() => void toggleFullscreen()}>Fullscreen</button><button onClick={hideControls} aria-label="Hide controls">Hide</button><button onClick={() => { void save(); onClose() }} aria-label="Close player">Close</button></div>
    </div>
    {audioOpen && <section class="subtitle-panel audio-panel"><h2>Audio track</h2>{mediaInfo?.audioTracks.map(track => <button class={track.streamIndex === selectedAudio ? 'selected' : ''} onClick={() => void chooseAudio(track)}><strong>{audioTrackLabel(track)}</strong>{track.default && <span>Default track</span>}</button>)}</section>}
    {subtitleOpen && <section class="subtitle-panel"><h2>Subtitles</h2><button class={selectedSubtitle === 'off' ? 'selected' : ''} onClick={() => disableSubtitles()}>Off</button>{subtitleGroups.map(group => <div class="subtitle-group" key={group.key}><p class="subtitle-group-label">{group.label}</p>{group.items.map(candidate => { const position = subtitlePositions.get(candidate) ?? 0; return <button key={`${candidate.provider}:${candidate.id}`} class={selectedSubtitle === `${candidate.provider}:${candidate.id}` ? 'selected' : ''} onClick={() => void chooseSubtitle(candidate)}><strong>{subtitleItemLabel(candidate, position)}</strong><span>{[languageDisplayName(candidate.language), candidate.format || '', candidate.hearingImpaired ? 'hearing impaired' : ''].filter(Boolean).join(' · ')}</span>{candidate.releaseName && <small>{candidate.releaseName}</small>}</button> })}</div>)}{candidates.length === 0 && <p>No matching downloadable subtitles were found.</p>}{warnings.map(w => <p class="danger"><strong>{w.provider}</strong>: {w.message}</p>)}</section>}
    {message && <p class="player-status" role="status">{message}</p>}
  </div>;
}

function App() {
  const initialRoute = parsePath(location.pathname, location.search);
  const [view, setView] = useState<View>(initialRoute.view); const [titles, setTitles] = useState<CatalogTitle[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null); const [household, setHousehold] = useState<HouseholdState>(emptyState); const [downloads, setDownloads] = useState<Download[]>([]); const [hero, setHero] = useState<CatalogTitle | null>(null); const [detail, setDetail] = useState<CatalogDetail | null>(null); const [detailTarget, setDetailTarget] = useState<DetailTarget>({}); const [picker, setPicker] = useState<CatalogSource[] | null>(null); const [player, setPlayer] = useState<ActivePlayer | null>(null); const [draftQuery, setDraftQuery] = useState(initialRoute.query || ''); const [query, setQuery] = useState(initialRoute.query || ''); const [searching, setSearching] = useState(false); const [updatesAvailable, setUpdatesAvailable] = useState(false); const [category, setCategory] = useState(''); const [kind, setKind] = useState(''); const [resolution, setResolution] = useState(''); const [sort, setSort] = useState('newest'); const [facets, setFacets] = useState<{ categories: string[]; resolutions: string[] }>({ categories: [], resolutions: [] }); const [libraryCategories, setLibraryCategories] = useState<LibraryCategory[]>([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [settings, setSettings] = useState<Record<string, unknown> | null>(null); const [settingsFields, setSettingsFields] = useState<SettingsField[]>([]); const loadMore = useRef<HTMLDivElement>(null); const requestGeneration = useRef(0); const inFlightCursor = useRef(''); const viewportInput = useRef(0); const catalogParams = useRef({ query, category, kind, resolution, sort }); catalogParams.current = { query, category, kind, resolution, sort };
  const detailRef = useRef<CatalogDetail | null>(null); const loadDownloadsRef = useRef<() => Promise<void>>(async () => { }); detailRef.current = detail;
  const loadState = async () => { try { setHousehold(await api.state()); } catch (e) { setError((e as Error).message) } };
  useOverlayFocus(Boolean(detail) && !picker, () => setDetail(null)); useOverlayFocus(Boolean(picker), () => setPicker(null));
  const navigate = (next: View) => { setDetail(null); setView(next); pushRoute({ view: next, query: next === 'search' ? query : '' }) };
  const loadDownloads = async () => { const anchor = captureDownloadAnchor(); const inputVersion = viewportInput.current; try { const incoming = (await api.downloads()).items; setDownloads(current => reconcileDownloads(current, incoming)); window.requestAnimationFrame(() => { if (inputVersion === viewportInput.current) restoreDownloadAnchor(anchor) }) } catch (e) { setError((e as Error).message) } }; loadDownloadsRef.current = loadDownloads;
  const loadTitles = async (append = false, cursor = '') => { if (append && inFlightCursor.current === cursor) return; const generation = append ? requestGeneration.current : ++requestGeneration.current; if (append) inFlightCursor.current = cursor; setLoading(true); const p = catalogParams.current; try { const page = await api.titles({ search: p.query, category: p.category, kind: p.kind, resolution: p.resolution, sort: p.sort, pageSize: 24, cursor }); if (generation !== requestGeneration.current) return; setTitles(current => { if (!append) return page.items; const seen = new Set(current.map(item => item.id)); return [...current, ...page.items.filter(item => !seen.has(item.id))] }); setNextCursor(page.nextCursor); setHero(h => h || page.items[0] || null); void api.ensureMetadata(page.items.slice(0, 12).map(item => item.id)).catch(() => { }); setError(''); } catch (e) { if (generation === requestGeneration.current) setError((e as Error).message) } finally { if (inFlightCursor.current === cursor) inFlightCursor.current = ''; if (generation === requestGeneration.current) setLoading(false) } };
  useEffect(() => { void Promise.all([loadState(), loadTitles(), api.facets().then(f => setFacets(f)).catch(() => { })]); }, []);
  useEffect(() => { void loadTitles(false, ''); }, [query, category, kind, resolution, sort]);
  useEffect(() => { if (!loadMore.current) return; const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting && nextCursor && !loading) void loadTitles(true, nextCursor) }, { rootMargin: '500px' }); observer.observe(loadMore.current); return () => observer.disconnect() }, [nextCursor, loading, query, category, kind, resolution, sort]);
  useEffect(() => { const stream = new EventSource('/api/v1/events'); const catalog = (event: MessageEvent) => { setUpdatesAvailable(true); try { const envelope = JSON.parse(event.data); const payload = typeof envelope.payload === 'string' ? JSON.parse(envelope.payload) : envelope.payload; const titleId = String(payload.titleId || ''); if (titleId && detailRef.current?.title.id === titleId) void api.title(titleId).then(setDetail).catch(e => setError((e as Error).message)) } catch { } }; const metadata = (event: MessageEvent) => { try { const envelope = JSON.parse(event.data); const payload = typeof envelope.payload === 'string' ? JSON.parse(envelope.payload) : envelope.payload; const title = payload.title as CatalogTitle | undefined; if (!title?.id) return; setTitles(current => current.map(item => item.id === title.id ? title : item)); setHero(current => current?.id === title.id ? title : current); setDetail(current => current?.title.id === title.id ? { ...current, title } : current) } catch { } }; const searchComplete = (event: MessageEvent) => { try { const envelope = JSON.parse(event.data); const payload = typeof envelope.payload === 'string' ? JSON.parse(envelope.payload) : envelope.payload; if (String(payload.query || '').toLowerCase() === catalogParams.current.query.toLowerCase()) void loadTitles(false, '') } catch { } }; const state = () => void loadState(); stream.addEventListener('catalog.updated', catalog as EventListener); stream.addEventListener('catalog.search.completed', searchComplete as EventListener); stream.addEventListener('metadata.updated', metadata as EventListener); stream.addEventListener('playback.updated', state); return () => stream.close() }, []);
  useEffect(() => { if (view === 'library-categories') void api.libraryCategories().then(page => setLibraryCategories(page.items as LibraryCategory[])).catch(e => setError(e.message)); if (view === 'settings') void Promise.all([api.call<Record<string, unknown>>('/settings').then(setSettings), api.call<{ items: SettingsField[] }>('/settings/schema').then(value => setSettingsFields(value.items))]).catch(e => setError(e.message)); }, [view]);
  useEffect(() => { if (view !== 'downloads') return; let stopped = false; let running = false; const refresh = async () => { if (stopped || running) return; running = true; try { await loadDownloadsRef.current() } finally { running = false } }; void refresh(); const timer = window.setInterval(() => void refresh(), 3000); return () => { stopped = true; window.clearInterval(timer) } }, [view]);
  useEffect(() => { const titleId = detail?.title.kind === 'series' ? detail.title.id : ''; if (!titleId) return; let stopped = false; let running = false; const refresh = async () => { if (stopped || running) return; running = true; try { const next = await api.title(titleId); if (!stopped && detailRef.current?.title.id === titleId) setDetail(next) } catch (e) { if (!stopped) setError((e as Error).message) } finally { running = false } }; const timer = window.setInterval(() => void refresh(), 3000); return () => { stopped = true; window.clearInterval(timer) } }, [detail?.title.id]);
  useEffect(() => { const moved = () => { viewportInput.current++ }; window.addEventListener('wheel', moved, { passive: true }); window.addEventListener('touchmove', moved, { passive: true }); window.addEventListener('keydown', moved); return () => { window.removeEventListener('wheel', moved); window.removeEventListener('touchmove', moved); window.removeEventListener('keydown', moved) } }, []);
  useEffect(() => {
    const restore = () => { const route = parsePath(location.pathname, location.search); setDetail(null); setView(route.view); if (route.view === 'search') { setDraftQuery(route.query || ''); setQuery(route.query || '') } };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  async function openTitle(title: CatalogTitle, target: DetailTarget = {}) { setHero(title); setDetailTarget(target); try { const next = await api.title(title.id); setDetail(next); if (needsEpisodeExpansion(next)) void api.refreshTitle(title.id, title.title).catch(e => setError((e as Error).message)) } catch (e) { setError((e as Error).message) } }
  async function openLibraryItem(item: HouseholdItem) { const id = item.titleId || item.catalog?.id; if (!id) { setError('This library item is not linked to a catalog title yet. Refresh the catalog and try again.'); return } const title = item.catalog || { id, title: item.release.name, kind: 'movie', categories: [], resolutions: [], sourceCount: 1, bestSeeders: item.release.seeders, largestSizeBytes: item.release.sizeBytes, libraryState: { downloadState: 'none', watchState: 'unwatched' } } as CatalogTitle; await openTitle(title, { season: item.seasonNumber, episode: item.episodeNumber }) }
  async function prepare(source: CatalogSource, resumeMs = 0) { try { setPicker(null); const d = await api.prepare(source.release.id, source.fileIndex ?? -1); if (!resumeMs) resumeMs = await api.playback(d.id).then(p => p.watched ? 0 : p.positionMs).catch(() => 0); setPlayer({ download: d, resumeMs }); } catch (e) { setError((e as Error).message) } }
  function playDetail(d: CatalogDetail) { const sources = d.title.kind === 'movie' ? d.sources : d.seasons[0]?.episodes[0]?.sources || []; if (sources.length === 1) void prepare(sources[0]); else setPicker(sources) }
  async function playLegacy(item: HouseholdItem) { try { const d = await api.prepare(item.release.id, item.fileIndex); setPlayer({ download: d, resumeMs: item.watched ? 0 : item.positionMs }) } catch (e) { setError((e as Error).message) } }
  async function playDownload(download: Download) { const resumeMs = await api.playback(download.id).then(value => value.watched ? 0 : value.positionMs).catch(() => 0); setPlayer({ download, resumeMs }) }
  async function advanceEpisode(preferences: PlaybackPreferences) { if (!player) return; try { const next = await api.nextEpisode(player.download.id); await Promise.all([loadState(), loadDownloads()]); if (next) setPlayer({ download: next, resumeMs: 0, preferences: { ...preferences, sourceId: next.id, subtitleMode: preferences.subtitleMode === 'off' ? 'off' : 'auto', subtitleProvider: '', subtitleCandidateId: '' } }); else setPlayer(null) } catch (e) { setError(`Could not start the next episode: ${(e as Error).message}`); setPlayer(null) } }
  async function downloadSeason(source: CatalogSource, season: number) { try { await api.prepareSeason(source.release.id, season); await loadDownloads(); if (detailRef.current) { const next = await api.title(detailRef.current.title.id); setDetail(next); setDetailTarget({ season }) } } catch (e) { setError((e as Error).message) } }
  async function manageSeasonPack(source: CatalogSource, season: number, action: 'download' | 'pause' | 'resume' | 'retry' | 'delete') { try { if (action === 'download' || (action === 'retry' && !source.libraryState?.downloadId)) { await downloadSeason(source, season); return } const id = source.libraryState?.downloadId; if (!id) throw new Error('This season download is not registered yet. Refresh the title and try again.'); if (action === 'delete') await api.deleteDownload(id); else await api.call(`/downloads/${encodeURIComponent(id)}/${action}`, { method: 'POST' }); await loadDownloads(); if (detailRef.current) setDetail(await api.title(detailRef.current.title.id)) } catch (e) { setError((e as Error).message); throw e } }
  async function remove(d: Download) { try { await api.deleteDownload(d.id); await loadDownloads() } catch (e) { setError((e as Error).message); throw e } }
  async function submitSearch(event?: Event, valueOverride?: string) { event?.preventDefault(); const value = (valueOverride ?? draftQuery).trim(); if (value === query) { void loadTitles(false, ''); return } setSearching(true); setError(''); try { if (value) { const page = await api.searchTitles(value); setTitles(page.items); setNextCursor(page.nextCursor); setHero(page.items[0] || null); void api.ensureMetadata(page.items.slice(0, 12).map(item => item.id)).catch(() => { }); } setQuery(value); setUpdatesAvailable(false); if (view === 'search') replaceRoute({ view: 'search', query: value }) } catch (e) { setError((e as Error).message) } finally { setSearching(false) } }
  async function applyUpdates() { setUpdatesAvailable(false); await loadTitles(false, '') }
  const pageTitle = navGroups.flatMap(g => g.items).find(i => i.id === view)?.label || 'Home';
  const continueWatching = canonicalHouseholdItems(household.continueWatching); const favorites = canonicalHouseholdItems(household.favorites); const recent = canonicalHouseholdItems(household.recent); const watched = canonicalHouseholdItems(household.watched);
  const libraryItems = view === 'continue' ? continueWatching : view === 'favorites' ? favorites : view === 'watched' ? watched : [];
  const showCatalog = ['tracker', 'browse', 'categories', 'search'].includes(view);
  return <div class="app-shell"><Sidebar view={view} onView={navigate} /><main class="content" id="content"><header class="topbar"><div><h1>{pageTitle}</h1><p>{view === 'home' ? 'Your private screening archive' : view === 'browse' ? 'Every title, grouped and ready to compare' : ''}</p></div><button class="avatar" aria-label="Household profile">H</button></header>{error && <div class="error" role="alert"><strong>Something needs attention</strong><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    {view === 'home' && <><Hero title={hero} onOpen={openTitle} /><Rail title="Continue watching" empty="Start a movie or episode and it will appear here." landscape>{continueWatching.map(i => <LegacyCard item={i} onOpen={openLibraryItem} />)}</Rail><Rail title="Recently added">{titles.slice(0, 12).map(t => <MediaCard title={t} onOpen={openTitle} />)}</Rail><Rail title="Favorites" empty="Favorite a title to keep it close." landscape>{favorites.map(i => <LegacyCard item={i} onOpen={openLibraryItem} />)}</Rail></>}
    {view === 'library' && <><Rail title="Continue watching" landscape>{continueWatching.map(i => <LegacyCard item={i} onOpen={openLibraryItem} />)}</Rail><Rail title="Recently viewed" landscape>{recent.map(i => <LegacyCard item={i} onOpen={openLibraryItem} />)}</Rail><Rail title="Watched" landscape>{watched.map(i => <LegacyCard item={i} onOpen={openLibraryItem} />)}</Rail></>}
    {['continue', 'favorites', 'watched'].includes(view) && <Rail title={pageTitle} empty={`No ${pageTitle.toLowerCase()} yet.`} landscape>{libraryItems.map(i => <LegacyCard item={i} onOpen={openLibraryItem} />)}</Rail>}
    {showCatalog && <><CatalogTools draftQuery={draftQuery} setDraftQuery={setDraftQuery} query={query} searching={searching} onSubmit={submitSearch} category={category} setCategory={setCategory} kind={kind} setKind={setKind} resolution={resolution} setResolution={setResolution} sort={sort} setSort={setSort} facets={facets} />{updatesAvailable && <button class="catalog-update" onClick={() => void applyUpdates()}>Catalog updates available · Refresh</button>}{view === 'categories' ? <CategoryGrid categories={facets.categories} onSelect={c => { setCategory(c); navigate('browse') }} /> : view === 'tracker' ? <><Rail title="Recently added">{titles.slice(0, 12).map(t => <MediaCard title={t} onOpen={openTitle} />)}</Rail><Rail title="Strong swarms">{[...titles].sort((a, b) => b.bestSeeders - a.bestSeeders).slice(0, 12).map(t => <MediaCard title={t} onOpen={openTitle} />)}</Rail></> : <><section class="poster-grid" aria-busy={loading}>{titles.map(t => <MediaCard title={t} onOpen={openTitle} />)}</section>{loading && <section class="poster-grid">{Array.from({ length: 12 }, (_, i) => <div class="skeleton" key={i} />)}</section>}<div ref={loadMore} class="load-more" aria-hidden="true" /></>}</>}
    {view === 'downloads' &&
      <Downloads items={downloads} onRefresh={loadDownloads} onPlay={d => void playDownload(d)} onRemove={remove} />
    }
    {view === 'library-categories' &&
      <LibraryCategories items={libraryCategories} onOpen={openLibraryItem} />
    }
    {view === 'jobs' && <Jobs onError={setError} />
    }
    {view === 'events' && <><CacheCoverage /><Events onError={setError} /></>
    }
    {view === 'settings' && settings && <><Settings value={settings} fields={settingsFields} onSaved={setSettings} onError={setError} /><CacheCoverage /><SubtitleProviderSettings value={settings} fields={settingsFields} onSaved={setSettings} onError={setError} /></>
    }
  </main>{detail && <Detail key={`${detail.title.id}:${detailTarget.season || 0}:${detailTarget.episode || 0}`} detail={detail} target={detailTarget} resume={resumeForTitle(household.continueWatching, detail.title.id)} favorite={household.favorites.some(item => item.titleId === detail.title.id || item.catalog?.id === detail.title.id)} onClose={() => setDetail(null)} onPlay={() => playDetail(detail)} onResume={playLegacy} onSource={s => void prepare(s)} onPackAction={manageSeasonPack} onFavorite={async value => { await api.titleFavorite(detail.title.id, value); await loadState(); }} />}{picker && <SourcePicker sources={picker} onClose={() => setPicker(null)} onChoose={s => void prepare(s)} />} {player && <BrowserPlayer key={player.download.id} active={player} onClose={() => setPlayer(null)} onStateChanged={loadState} onAdvance={advanceEpisode} />}</div>;
}

function Hero({ title, onOpen }: { title: CatalogTitle | null; onOpen: (t: CatalogTitle) => void }) { if (!title) return <section class="hero empty-hero"><h2>Connect your catalog</h2><p>Configure FileList in Settings, then return here to browse.</p></section>; return <section class="hero"><div class="hero-art"><Artwork title={title} kind="backdrop" /></div><div class="hero-shade" /><div class="hero-copy"><h2>{title.title}</h2><p class="hero-meta">{[title.year, title.kind === 'series' ? `${title.seasonCount || 0} seasons` : 'Movie', title.resolutions[0], `${title.bestSeeders} seeds`].filter(Boolean).join(' · ')}</p><p>{title.overview || 'Metadata is being prepared. Source facts are available now.'}</p><button class="primary" onClick={() => onOpen(title)}><Icon name="play" /><span>View and play</span></button></div></section> }

function CatalogTools(p: any) { return <form class="catalog-tools" onSubmit={p.onSubmit}><label class="search"><Icon name="search" /><input value={p.draftQuery} onInput={(e: any) => p.setDraftQuery(e.currentTarget.value)} placeholder="Search FileList titles, years or releases" aria-label="Search FileList" /></label><button class="search-submit primary" type="submit" disabled={p.searching}>{p.searching ? 'Searching…' : 'Search'}</button>{p.query && <button type="button" onClick={() => { p.setDraftQuery(''); p.onSubmit(undefined, '') }}>Clear</button>}<select value={p.category} onChange={(e: any) => p.setCategory(e.currentTarget.value)} aria-label="Category"><option value="">All categories</option>{p.facets.categories.map((x: string) => <option>{x}</option>)}</select><select value={p.kind} onChange={(e: any) => p.setKind(e.currentTarget.value)} aria-label="Media type"><option value="">Movies and series</option><option value="movie">Movies</option><option value="series">Series</option></select><select value={p.resolution} onChange={(e: any) => p.setResolution(e.currentTarget.value)} aria-label="Resolution"><option value="">All resolutions</option>{p.facets.resolutions.map((x: string) => <option>{x}</option>)}</select><select value={p.sort} onChange={(e: any) => p.setSort(e.currentTarget.value)} aria-label="Sort"><option value="newest">Recently added</option><option value="title">Title A–Z</option><option value="rating">Highest rated</option><option value="rating-asc">Lowest rated</option><option value="seeders">Most seeders</option><option value="size">Largest size</option></select><span class="search-scope">Search contacts FileList only after submit; filters use the local cache.</span></form> }
function CategoryGrid({ categories, onSelect }: { categories: string[]; onSelect: (c: string) => void }) { return <section class="category-grid">{categories.map(c => <button onClick={() => onSelect(c)}><Icon name="folder" /><strong>{c}</strong><span>Browse category</span></button>)}</section> }

function sourceActionLabel(source: CatalogSource) { return source.libraryState?.downloadState && source.libraryState.downloadState !== 'none' ? 'Play' : 'Play and download' }
type SeasonPackAction = 'download' | 'pause' | 'resume' | 'retry' | 'delete';
function SeasonPackCard({ source, season, open, onToggle, onAction, onDelete }: { source: CatalogSource; season: number; open: boolean; onToggle: () => void; onAction: (source: CatalogSource, season: number, action: SeasonPackAction) => Promise<void>; onDelete: () => void }) {
  const state = source.libraryState; const [busy, setBusy] = useState(''); const managed = Boolean(state?.downloadId); const paused = state?.transferState === 'paused'; const complete = state?.downloadState === 'downloaded'; const error = state?.downloadState === 'error';
  const run = async (action: SeasonPackAction) => { if (busy) return; setBusy(action); try { await onAction(source, season, action) } finally { setBusy('') } };
  return <article class={`season-pack-source ${open ? 'expanded' : ''}`}><button class="season-pack-header" aria-expanded={open} aria-controls={`pack-${source.release.id}`} onClick={onToggle}><span class="season-pack-copy"><strong>{source.parsed.resolution || 'Season pack'}{source.parsed.hdr ? ` · ${source.parsed.hdr}` : ''}</strong><span>{source.release.name}</span><small>{[source.parsed.quality, source.parsed.videoCodec, source.parsed.audio].filter(Boolean).join(' · ') || 'Source details unavailable'}</small></span><span class="season-pack-state"><MediaBadges state={state} /><b>{seasonPackActionLabel(state)}</b><small>{formatBytes(source.release.sizeBytes)} · {source.release.seeders} seeds</small><small>{open ? 'Hide controls' : 'Show controls'}</small></span></button>{open && <div id={`pack-${source.release.id}`} class="season-pack-controls"><progress value={state?.progress || 0} max="1" aria-label="Season download progress" />{!managed && <button class="primary" disabled={Boolean(busy)} onClick={() => void run('download')}>{busy ? 'Starting…' : 'Download season'}</button>}{managed && !complete && !error && <button disabled={Boolean(busy)} onClick={() => void run(paused ? 'resume' : 'pause')}>{busy ? `${paused ? 'Resuming' : 'Pausing'}…` : paused ? 'Resume' : 'Pause'}</button>}{error && <button class="primary" disabled={Boolean(busy)} onClick={() => void run('retry')}>{busy ? 'Retrying…' : 'Retry'}</button>}{managed && <button class="danger-button" disabled={Boolean(busy)} onClick={onDelete}>Delete download</button>}</div>}</article>;
}
function Detail({ detail, target, resume, favorite, onClose, onPlay, onResume, onSource, onPackAction, onFavorite }: { detail: CatalogDetail; target: DetailTarget; resume?: HouseholdItem; favorite: boolean; onClose: () => void; onPlay: () => void; onResume: (item: HouseholdItem) => void; onSource: (s: CatalogSource) => void; onPackAction: (s: CatalogSource, season: number, action: SeasonPackAction) => Promise<void>; onFavorite: (v: boolean) => void }) {
  const initialIndex = Math.max(0, detail.seasons.findIndex(item => item.number === target.season)); const [t, setT] = useState(initialIndex); const [expanded, setExpanded] = useState(target.episode ? `${target.season}:${target.episode}` : ''); const [expandedPack, setExpandedPack] = useState(''); const [pendingPack, setPendingPack] = useState<CatalogSource | null>(null); const [deleting, setDeleting] = useState(false); const season = detail.seasons[t]; const firstSource = detail.title.kind === 'movie' ? detail.sources[0] : season?.episodes[0]?.sources[0]; const canPlay = Boolean(firstSource); useOverlayFocus(Boolean(pendingPack), () => { if (!deleting) setPendingPack(null) }); const confirmDelete = async () => { if (!pendingPack || !season || deleting) return; setDeleting(true); try { await onPackAction(pendingPack, season.number, 'delete'); setPendingPack(null) } finally { setDeleting(false) } };
  return <div class="overlay" role="dialog" aria-modal="true" aria-label={`${detail.title.title} details`}><article class="detail"><button class="close" onClick={onClose}>Close</button><div class="detail-hero"><Artwork title={detail.title} kind="backdrop" /><div /><section><h2>{detail.title.title}</h2><p>{[detail.title.year, detail.title.kind === 'series' ? `${detail.title.seasonCount} seasons` : 'Movie', `${detail.title.bestSeeders} seeds`].filter(Boolean).join(' · ')}</p><MediaBadges state={detail.title.libraryState} /><p>{detail.title.overview || 'Metadata is still being prepared.'}</p><div class="actions">{resume ? <button class="primary" onClick={() => onResume(resume)} aria-label={`${resumeActionLabel(resume, detail.title.kind)} at saved position`}><Icon name="play" />{resumeActionLabel(resume, detail.title.kind)}</button> : canPlay && <button class="primary" onClick={onPlay}><Icon name="play" />{firstSource ? sourceActionLabel(firstSource) : 'Play'}</button>}<button onClick={() => void onFavorite(!favorite)}><Icon name="heart" />{favorite ? 'Remove favorite' : 'Favorite'}</button></div>{resume && <small class="resume-file">{resumeSummary(resume, detail.title.kind)}</small>}</section></div>{detail.title.kind === 'series' ? <><div class="season-tabs">{detail.seasons.map((s, i) => <button class={i === t ? 'selected' : ''} onClick={() => { setT(i); setExpanded(''); setExpandedPack('') }}><span>{s.title}</span><MediaBadges state={s.libraryState} /></button>)}</div>{season?.packSources && season.packSources.length > 0 && <section class="season-pack-actions"><h3>Complete season versions</h3><p>Select a version to review it. Downloads start only from the button inside the expanded version.</p><div>{season.packSources.map(source => <SeasonPackCard key={source.release.id} source={source} season={season.number} open={expandedPack === source.release.id} onToggle={() => setExpandedPack(current => current === source.release.id ? '' : source.release.id)} onAction={onPackAction} onDelete={() => setPendingPack(source)} />)}</div></section>}{season && season.episodes.length > 0 ? <div class="episode-list">{season.episodes.map(e => { const key = `${e.season}:${e.number}`; const open = expanded === key; return <article class={open ? 'expanded' : ''}><button class="episode-select" aria-expanded={open} onClick={() => setExpanded(current => current === key ? '' : key)}><div class="episode-art"><Artwork title={detail.title} kind="backdrop" /></div><span class="episode-copy"><strong>{e.number ? `${e.number}. ` : ''}{e.title}</strong><small>{e.sourceCount} version{e.sourceCount === 1 ? '' : 's'}</small><MediaBadges state={e.libraryState} /><b>{open ? 'Hide versions' : 'Show versions'}</b></span></button>{open && <SourceRows sources={e.sources} onSource={onSource} compact />}</article> })}</div> : <p class="episode-loading" role="status">Preparing the individual episode list. This page updates automatically when it is ready.</p>}</> : <SourceRows sources={detail.sources} onSource={onSource} />}</article>{pendingPack && <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="season-pack-delete-heading"><section class="removal-confirm"><h2 id="season-pack-delete-heading">Delete season download?</h2><p class="release-name">{pendingPack.release.name}</p><p>This removes the shared season torrent from qBittorrent and permanently deletes every episode file in it.</p><div class="confirm-actions"><button disabled={deleting} onClick={() => setPendingPack(null)}>Cancel</button><button class="danger-button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? 'Deleting…' : 'Delete download'}</button></div></section></div>}</div>;
}
function SourceRows({ sources, onSource, compact = false }: { sources: CatalogSource[]; onSource: (s: CatalogSource) => void; compact?: boolean }) { const ordered = [...sources].sort((a, b) => { const rank = (source: CatalogSource) => source.libraryState?.downloadState === 'downloaded' ? 0 : source.libraryState?.downloadState && source.libraryState.downloadState !== 'none' ? 1 : 2; return rank(a) - rank(b) || b.release.seeders - a.release.seeders }); return <div class={`source-rows ${compact ? 'compact' : ''}`}>{ordered.map(s => <button onClick={() => onSource(s)}><span class="source-copy"><strong>{s.parsed.resolution || 'Source'}</strong><span class="source-filename">{s.filePath || s.release.name}</span><small>{[s.parsed.hdr, s.parsed.quality, s.parsed.videoCodec].filter(Boolean).join(' · ')}</small></span><span class="source-action"><MediaBadges state={s.libraryState} /><b>{sourceActionLabel(s)}</b><small>{formatBytes(s.fileSizeBytes || s.release.sizeBytes)} · {s.release.seeders} seeds</small></span></button>)}</div> }
function SourcePicker({ sources, onClose, onChoose }: { sources: CatalogSource[]; onClose: () => void; onChoose: (s: CatalogSource) => void }) {
  const [sort, setSort] = useState('seeders'); const ranks: Record<string, number> = { "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 }; const resolution = (value: string) => ranks[value] || 0;
  const sorted = [...sources].sort((a, b) => sort === 'size' ? (b.fileSizeBytes || b.release.sizeBytes) - (a.fileSizeBytes || a.release.sizeBytes) : sort === 'resolution' ? resolution(b.parsed.resolution || '') - resolution(a.parsed.resolution || '') : b.release.seeders - a.release.seeders);
  return <div class="overlay picker" role="dialog" aria-modal="true" aria-label="Choose version"><section><header><h2>Choose version</h2><select value={sort} onChange={event => setSort(event.currentTarget.value)} aria-label="Sort versions"><option value="seeders">Most seeders</option><option value="resolution">Best resolution</option><option value="size">Largest file</option></select><button onClick={onClose}>Close</button></header><SourceRows sources={sorted} onSource={onChoose} /></section></div>
}

function Downloads({ items, onRefresh, onPlay, onRemove }: { items: Download[]; onRefresh: () => void; onPlay: (d: Download) => void; onRemove: (d: Download) => Promise<void> }) {
  const [pending, setPending] = useState<Download | null>(null); const [removing, setRemoving] = useState(false); const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all'); const [sort, setSort] = useState<DownloadSort>('recent'); const [order, setOrder] = useState<string[]>(() => orderDownloadIDs(items, 'recent')); useOverlayFocus(Boolean(pending), () => { if (!removing) setPending(null) });
  const idsKey = items.map(item => item.id).join('\u0000');
  useEffect(() => setOrder(current => { const available = new Set(items.map(item => item.id)); const retained = current.filter(id => available.has(id)); const known = new Set(retained); const added = items.filter(item => !known.has(item.id)).map(item => item.id); return [...added, ...retained] }), [idsKey]);
  const changeSort = (next: DownloadSort) => { setSort(next); setOrder(orderDownloadIDs(items, next)) };
  const facts = (download: Download) => [download.parsed?.resolution, download.parsed?.quality, download.parsed?.videoCodec, download.parsed?.audio, download.category].filter(Boolean).join(' · ');
  const visible = useMemo(() => { const term = query.trim().toLocaleLowerCase(); const byID = new Map(items.map(item => [item.id, item])); const ordered = (order.length ? order : items.map(item => item.id)).map(id => byID.get(id)).filter((item): item is Download => Boolean(item)); return ordered.filter(download => { const text = [download.displayTitle, download.releaseName, download.filePath, download.category, download.state].filter(Boolean).join(' ').toLocaleLowerCase(); const matchesFilter = filter === 'all' || filter === 'streaming' && download.playbackMode === 'progressive' || filter === 'complete' && download.playbackMode === 'local' || filter === 'paused' && download.state.toLocaleLowerCase().startsWith('paused') || filter === 'errors' && Boolean(download.error); return (!term || text.includes(term)) && matchesFilter }) }, [items, order, query, filter]);
  const confirmRemoval = async () => { if (!pending || removing) return; setRemoving(true); try { await onRemove(pending); setPending(null) } finally { setRemoving(false) } };
  return <section><div class="catalog-tools download-tools"><label class="search"><Icon name="search" /><input value={query} onInput={event => setQuery(event.currentTarget.value)} placeholder="Search downloaded titles, releases, or files" aria-label="Search downloads" /></label><select value={filter} onChange={event => setFilter(event.currentTarget.value)} aria-label="Filter downloads"><option value="all">All downloads</option><option value="streaming">Still downloading</option><option value="complete">Downloaded</option><option value="paused">Paused</option><option value="errors">Needs attention</option></select><select value={sort} onChange={event => changeSort(event.currentTarget.value as DownloadSort)} aria-label="Sort downloads"><option value="recent">Recently added</option><option value="title">Title A–Z</option><option value="progress">Most progress</option><option value="size">Largest file</option><option value="speed">Fastest download</option></select><button onClick={onRefresh}>Refresh</button><span class="search-scope" aria-live="polite">{visible.length} of {items.length} downloads shown</span></div><div class="download-list">{visible.length === 0 ? <p class="empty">{items.length === 0 ? 'Downloads you start will appear here.' : 'No downloads match this search and filter.'}</p> : visible.map(download => <article key={download.id} data-download-id={download.id}><div class="download-identity"><h2 title={download.displayTitle || download.filePath}>{download.displayTitle || download.filePath}</h2><p class="release-name" title={download.releaseName || download.filePath}>{download.releaseName || download.filePath}</p><span class={`stream-mode ${download.playbackMode}`}>{download.playbackMode === 'progressive' ? 'Progressive stream' : 'Downloaded file'}</span><dl><div><dt>Selected file</dt><dd title={download.filePath}>{download.filePath}</dd></div><div><dt>Source</dt><dd>{facts(download) || 'Source details unavailable'}</dd></div><div><dt>Selected file size</dt><dd>{formatBytes(download.sizeBytes)} · index {download.fileIndex}</dd></div><div><dt>Complete torrent</dt><dd>{download.releaseId} · {download.trackerSeeders ?? '—'} tracker seeders{download.releaseSizeBytes ? ` · ${formatBytes(download.releaseSizeBytes)} total` : ''}</dd></div></dl><p class="download-telemetry">{download.state} · {(download.progress * 100).toFixed(1)}% · {formatBytes(download.downloadedBytes)} / {formatBytes(download.sizeBytes)} selected</p><progress value={download.progress} max="1" /><p class="download-telemetry">{formatBytes(download.speedBytesPerSecond)}/s · {download.seeds} connected seeds · {download.peers} peers</p><p class={`download-error ${download.error ? 'visible' : ''}`} aria-live="polite">{download.error || 'No download error'}</p></div><div class="download-actions"><button class="primary" onClick={() => onPlay(download)}>Play</button><button class="danger-button" onClick={() => setPending(download)}>Delete download</button></div></article>)}</div>{pending && <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="web-download-delete-heading"><section class="removal-confirm"><h2 id="web-download-delete-heading">Delete download?</h2><p class="release-name">{pending.releaseName || pending.filePath}</p><dl><div><dt>Selected file</dt><dd>{pending.filePath}</dd></div><div><dt>Tracker release ID</dt><dd>{pending.releaseId}</dd></div><div><dt>Selected file size</dt><dd>{formatBytes(pending.sizeBytes)}</dd></div></dl><p>This removes the torrent from qBittorrent and permanently deletes its incomplete and downloaded files.</p><div class="confirm-actions"><button disabled={removing} onClick={() => setPending(null)}>Cancel</button><button class="danger-button" disabled={removing} onClick={() => void confirmRemoval()}>{removing ? 'Deleting…' : 'Delete download'}</button></div></section></div>}</section>
}
function LibraryCategories({ items, onOpen }: { items: LibraryCategory[]; onOpen: (item: HouseholdItem) => void }) { const [selected, setSelected] = useState(''); const [media, setMedia] = useState<HouseholdItem[]>([]); const [message, setMessage] = useState(''); async function open(name: string) { setSelected(name); setMessage('Loading your media…'); try { const page = await api.libraryCategories(name); setMedia(canonicalHouseholdItems(page.items as HouseholdItem[])); setMessage('') } catch (e) { setMessage((e as Error).message) } } return <section><p class="supporting">Downloaded, watched, in-progress, and favorited media grouped by tracker category.</p>{selected && <button onClick={() => { setSelected(''); setMedia([]) }}>All categories</button>}{message && <p role="status">{message}</p>}{selected ? <><div class="section-heading category-heading"><h2>{selected}</h2><span>{media.length} item{media.length === 1 ? '' : 's'}</span></div><div class="library-category-media">{media.map(item => <LegacyCard item={item} onOpen={onOpen} />)}</div>{media.length === 0 && <p class="empty">No media remains in this category.</p>}</> : <section class="category-grid">{items.map(item => <button onClick={() => void open(item.name)}><Icon name="folder" /><strong>{item.name}</strong><span>{item.count} item{item.count === 1 ? '' : 's'}</span></button>)}</section>}</section> }

function Jobs({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<Job[]>([]); const [query, setQuery] = useState(''); const [state, setState] = useState(''); const [kind, setKind] = useState(''); const [retryable, setRetryable] = useState(''); const [updatedHours, setUpdatedHours] = useState(''); const [cursor, setCursor] = useState(''); const [next, setNext] = useState<string | null>(null); const [history, setHistory] = useState<string[]>([]); const [detail, setDetail] = useState<{ job: Job; logs: JobLog[] } | null>(null); const [logCursor, setLogCursor] = useState<string | null>(null); const [loading, setLoading] = useState(false); const [retrying, setRetrying] = useState(''); const [level, setLevel] = useState('');
  async function load(target = '', remember = false) { setLoading(true); try { const page = await api.jobs({ search: query, state, kind, retryable, updatedHours, pageSize: 24, cursor: target }); if (remember) setHistory(value => [...value, cursor]); setCursor(target); setItems(page.items); setNext(page.nextCursor) } catch (e) { onError((e as Error).message) } finally { setLoading(false) } }
  useEffect(() => { const timer = window.setTimeout(() => { setHistory([]); void load('') }, 300); return () => clearTimeout(timer) }, [query, state, kind, retryable, updatedHours]);
  async function retry(job: Job) { setRetrying(job.id); try { await api.retryJob(job.id); await load(cursor) } catch (e) { onError((e as Error).message) } finally { setRetrying('') } }
  async function open(job: Job) { try { const [result, logs] = await Promise.all([api.job(job.id), api.jobLogs(job.id)]); setDetail({ job: result.job, logs: logs.items }); setLogCursor(logs.nextCursor) } catch (e) { onError((e as Error).message) } }
  async function loadOlder() { if (!detail || !logCursor) return; try { const page = await api.jobLogs(detail.job.id, logCursor); setDetail({ ...detail, logs: [...detail.logs, ...page.items] }); setLogCursor(page.nextCursor) } catch (e) { onError((e as Error).message) } }
  useEffect(() => { if (!detail) return; const stream = new EventSource('/api/v1/events'); const append = (event: MessageEvent) => { try { const envelope = JSON.parse(event.data); const log = (typeof envelope.payload === 'string' ? JSON.parse(envelope.payload) : envelope.payload) as JobLog; if (log.jobId === detail.job.id) setDetail(current => current && current.job.id === log.jobId ? { ...current, logs: [log, ...current.logs].slice(0, 500) } : current) } catch { } }; stream.addEventListener('job.log', append as EventListener); return () => stream.close() }, [detail?.job.id]);
  const visibleLogs = detail?.logs.filter(log => !level || log.level === level) || [];
  return <section class="jobs"><div class="catalog-tools"><label class="search"><Icon name="search" /><input value={query} onInput={e => setQuery(e.currentTarget.value)} placeholder="Search jobs by ID, type, label, or error" /></label><select value={state} onChange={e => setState(e.currentTarget.value)} aria-label="Job state"><option value="">All states</option><option value="queued">Queued</option><option value="running">Running</option><option value="retry_wait">Retry waiting</option><option value="completed">Completed</option><option value="failed">Failed</option></select></div><p class="supporting">Persistent catalog and metadata work recorded by the server.</p>{loading && <p role="status">Loading jobs…</p>}{items.length === 0 && !loading ? <p class="empty">No matching jobs.</p> : items.map(job => <article><Icon name="activity" /><div><h2>{job.label || job.kind}</h2><p>{job.id} · {job.state} · {(job.progress * 100).toFixed(0)}% · updated {new Date(job.updatedAt).toLocaleString()}</p>{job.nextAttemptAt && <p>Next automatic attempt: {new Date(job.nextAttemptAt).toLocaleString()}</p>}<progress value={job.progress} max="1" />{job.error && <p class="danger">{job.error}</p>}<div class="job-actions"><button onClick={() => void open(job)}>Details</button><button disabled={job.state === 'queued' || job.state === 'running' || job.state === 'retry_wait' || retrying === job.id} onClick={() => void retry(job)}>{retrying === job.id ? 'Queueing…' : 'Retry'}</button></div></div></article>)}<nav class="pagination" aria-label="Job pages"><button disabled={history.length === 0} onClick={() => { const target = history[history.length - 1] || ''; setHistory(value => value.slice(0, -1)); void load(target) }}>Previous</button><button disabled={!next} onClick={() => next && void load(next, true)}>Next</button></nav>{detail && <div class="overlay" role="dialog" aria-modal="true" aria-label="Job details"><section class="help-modal job-log-modal"><button class="close" onClick={() => setDetail(null)}>Close</button><h2>{detail.job.label}</h2><p>{detail.job.id} · {detail.job.state} · attempt {detail.job.attempt}</p><div class="job-log-tools"><select value={level} onChange={event => setLevel(event.currentTarget.value)} aria-label="Log severity"><option value="">All levels</option><option value="info">Info</option><option value="warn">Warnings</option><option value="error">Errors</option></select><button onClick={() => void navigator.clipboard.writeText(visibleLogs.map(log => `${log.createdAt} [${log.level}] ${log.phase}: ${log.message}`).join('\n'))}>Copy visible logs</button></div>{visibleLogs.length === 0 ? <p class="empty">No structured logs were recorded for this legacy job.</p> : visibleLogs.map(log => <div class={`job-log ${log.level}`}><time>{new Date(log.createdAt).toLocaleString()} · attempt {log.attempt}</time><strong>{log.phase} · {log.level}</strong><pre>{log.message}</pre>{log.context && Object.keys(log.context).length > 0 && <pre class="job-context">{JSON.stringify(log.context, null, 2)}</pre>}</div>)}{logCursor && <button onClick={() => void loadOlder()}>Load older logs</button>}</section></div>}</section>
}

function Events({ onError }: { onError: (value: string) => void }) { const [message, setMessage] = useState(''); async function run(mode: 'latest' | 'rebuild') { try { const job = await api.syncCatalog(mode); setMessage(`${job.label} queued. Follow progress on Jobs.`) } catch (e) { onError((e as Error).message) } } return <section class="events-page"><p class="supporting">Run safe server maintenance without waiting for the schedule.</p><div class="event-actions"><article><h2>Fetch latest</h2><p>Append the newest FileList releases to the existing catalog.</p><button class="primary" onClick={() => void run('latest')}>Fetch latest data</button></article><article><h2>Rebuild catalog</h2><p>Refresh the maximum API-visible results from every enabled category. Existing discoveries are retained.</p><button onClick={() => void run('rebuild')}>Rebuild cache</button></article></div>{message && <p role="status" class="success">{message}</p>}</section> }

function CacheCoverage() { const [status, setStatus] = useState<Record<string, unknown> | null>(null); useEffect(() => { api.call<Record<string, unknown>>('/catalog/status').then(setStatus).catch(() => { }) }, []); if (!status) return null; return <section class="cache-coverage"><h2>Observed catalog coverage</h2><p><strong>{Number(status.observedReleases).toLocaleString()}</strong> releases retained · <strong>{Number(status.discoverableReleases).toLocaleString()}</strong> currently seeded · {Number(status.hiddenZeroSeeders).toLocaleString()} zero-seeder releases hidden</p><p class="supporting">FileList exposes at most {String(status.fileListLatestWindowLimit)} recent releases per latest request and no historical pagination. Searches and future syncs continue growing this append-only cache.</p></section> }

function SubtitleProviderSettings({ value, fields, onSaved, onError }: { value: Record<string, unknown>; fields: SettingsField[]; onSaved: (value: Record<string, unknown>) => void; onError: (message: string) => void }) {
  const [current, setCurrent] = useState({ ...value }); const [help, setHelp] = useState<SettingsField | null>(null); const [message, setMessage] = useState(''); const [tests, setTests] = useState<Record<string, string>>({});
  const rows: [string, string, string?][] = [['Preferred audio language', 'preferredAudioLanguage'], ['Preferred subtitle language', 'preferredSubtitleLanguage'], ['Fallback subtitle language', 'fallbackSubtitleLanguage'], ['SubDL API URL', 'subDLUrl'], ['SubDL API key', 'subDLApiKey', 'password'], ['Subtitle cache path', 'subtitleCachePath'], ['Subtitle cache maximum bytes', 'subtitleCacheMaxBytes', 'number'], ['ffprobe path', 'ffprobePath'], ['FFmpeg path', 'ffmpegPath']];
  const descriptor = (key: string, label: string) => fields.find(field => field.key === key) || { key, label, help: `Controls ${label.toLowerCase()}.`, obtain: '', tvVisible: false, sensitive: false, restartRequired: false };
  async function save(event: Event) { event.preventDefault(); const out = { ...current }; Object.keys(out).filter(key => key.endsWith('Configured') || key === 'settingsPath').forEach(key => delete out[key]); if (typeof out.trustedCidrs === 'string') out.trustedCidrs = out.trustedCidrs.split(',').map((item: string) => item.trim()).filter(Boolean); try { await api.call('/settings', { method: 'PUT', body: JSON.stringify(out) }); setMessage('Subtitle provider settings saved.'); onSaved(current) } catch (error) { onError((error as Error).message) } }
  async function test(name: 'subdl') { setTests(state => ({ ...state, [name]: 'Testing saved credentials…' })); try { const result = await api.call<{ message: string }>(`/dependencies/${name}/test`, { method: 'POST' }); setTests(state => ({ ...state, [name]: result.message })) } catch (error) { setTests(state => ({ ...state, [name]: (error as Error).message })) } }
  return <form class="settings subtitle-provider-settings" onSubmit={save}><fieldset><legend>Subtitle providers</legend><p class="supporting">Save credentials before testing them. Blank secrets keep their currently stored value.</p><section class="diagnostics"><h2>Provider connections</h2><div><button type="button" onClick={() => void test('subdl')}>Test SubDL</button><span role="status">{tests.subdl}</span></div></section><div class="fields">{rows.map(([label, key, type]) => { const info = descriptor(key, label); return <label><span>{label}{info.readOnly && <small> environment managed</small>}<button type="button" class="help-button" aria-label={`Help for ${label}`} title={info.help} onClick={() => setHelp(info)}>?</button></span><input disabled={info.readOnly} type={type || 'text'} value={String(current[key] ?? '')} placeholder={type === 'password' && value[`${key}Configured`] ? 'Configured — leave blank to keep' : ''} onInput={event => setCurrent({ ...current, [key]: type === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value })} /></label> })}</div></fieldset><div class="settings-actions"><button class="primary" type="submit">Save subtitle settings</button><span role="status">{message}</span></div>{help && <div class="overlay" role="dialog" aria-modal="true" aria-label={`Help for ${help.label}`}><section class="help-modal"><button type="button" class="close" onClick={() => setHelp(null)}>Close</button><h2>{help.label}</h2><p>{help.help}</p>{help.obtain && <><h3>Where to get it</h3><p>{help.obtain}</p></>}<button type="button" onClick={() => void navigator.clipboard.writeText([help.help, help.obtain].filter(Boolean).join('\n\n')).then(() => setMessage('Help copied.'))}>Copy help</button></section></div>}</form>
}

function Settings({ value, fields, onSaved, onError }: { value: Record<string, unknown>; fields: SettingsField[]; onSaved: (v: Record<string, unknown>) => void; onError: (s: string) => void }) {
  const [current, setCurrent] = useState({ ...value });
  const [message, setMessage] = useState('');
  const [help, setHelp] = useState<SettingsField | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const groups = [
    { title: 'Tracker and metadata', fields: [['FileList URL', 'fileListUrl'], ['FileList username', 'fileListUsername'], ['FileList passkey', 'fileListPasskey', 'password'], ['TMDB API key or token', 'tmdbApiKey', 'password'], ['Metadata language', 'metadataLanguage'], ['Metadata fallback language', 'metadataFallbackLanguage']] },
    { title: 'qBittorrent and storage', fields: [['qBittorrent URL', 'qbittorrentUrl'], ['qBittorrent username', 'qbittorrentUsername'], ['qBittorrent password', 'qbittorrentPassword', 'password'], ['Download root', 'downloadRoot'], ['Allocation (GB)', 'allocationGb', 'number', '0.5'], ['Free-space reserve (GB)', 'reserveGb', 'number', '0.5'], ['Artwork cache path', 'artworkCachePath'], ['Artwork cache maximum bytes', 'artworkCacheMaxBytes', 'number']] },
    { title: 'Playback and subtitles', fields: [['Initial buffer bytes', 'initialBufferBytes', 'number'], ['Read-ahead bytes', 'readAheadBytes', 'number'], ['Piece timeout seconds', 'pieceWaitTimeoutSeconds', 'number'], ['SubDL API URL', 'subDLUrl'], ['SubDL API key', 'subDLApiKey', 'password'], ['Preferred audio language', 'preferredAudioLanguage'], ['Preferred subtitle language', 'preferredSubtitleLanguage'], ['Fallback subtitle language', 'fallbackSubtitleLanguage'], ['Watched threshold percent', 'watchedThresholdPercent', 'number']] },
    { title: 'Server and background work', fields: [['Server name', 'instanceName'], ['Listen address', 'listenAddress'], ['Database path', 'databasePath'], ['Catalog max age hours', 'catalogMaxAgeHours', 'number'], ['Maximum concurrent jobs', 'maxConcurrentJobs', 'number'], ['Title refresh timeout minutes', 'titleRefreshTimeoutMinutes', 'number'], ['Trusted CIDRs (comma separated)', 'trustedCidrs']] },
  ] as any[];
  const descriptor = (key: string, label: string) => fields.find(field => field.key === key) || { key, label, help: `Controls ${label.toLowerCase()}.`, obtain: '', tvVisible: false, sensitive: false, restartRequired: false, readOnly: false };
  async function save(e: Event) {
    e.preventDefault();
    const out = { ...current };
    Object.keys(out).filter(k => k.endsWith('Configured') || k === 'settingsPath').forEach(k => delete out[k]);
    if (typeof out.trustedCidrs === 'string') out.trustedCidrs = out.trustedCidrs.split(',').map((x: string) => x.trim()).filter(Boolean);
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
        return <label><span>{label}{info.restartRequired && <small> restart required</small>}{info.readOnly && <small> environment managed</small>}<button type="button" class="help-button" aria-label={`Help for ${label}`} title={info.help} onClick={() => setHelp(info)}>?</button></span><input disabled={info.readOnly} type={type || 'text'} step={type === 'number' ? (step || undefined) : undefined} value={Array.isArray(current[key]) ? (current[key] as string[]).join(', ') : String(current[key] ?? '')} placeholder={type === 'password' && value[`${key}Configured`] ? 'Configured — leave blank to keep' : ''} onInput={e => setCurrent({ ...current, [key]: type === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value })} /></label>
      })}</div></fieldset>)}
      <Events onError={onError} />
      <div class="settings-actions"><button class="primary" type="submit">Save changes</button>{message && <span role="status">{message}</span>}</div>
    </form>
    {help && <div class="overlay" role="dialog" aria-modal="true" aria-label={`Help for ${help.label}`}><section class="help-modal"><button class="close" onClick={() => setHelp(null)}>Close</button><h2>{help.label}</h2><p>{help.help}</p>{help.readOnly && <p><strong>This setting is managed by the process environment and cannot be edited here.</strong></p>}{help.restartRequired && <p><strong>Restart required after changing this setting.</strong></p>}{help.obtain && <><h3>Where to get it</h3><p>{help.obtain}</p></>}<button onClick={() => void navigator.clipboard.writeText([help.help, help.obtain].filter(Boolean).join('\n\n')).then(() => setMessage('Help copied.'))}>Copy help</button></section></div>}
  </>
}

// Bootstrap when served from index.html; module imports (tests) skip the mount.
const appRoot = document.getElementById('app');
if (appRoot) render(<App />, appRoot);
