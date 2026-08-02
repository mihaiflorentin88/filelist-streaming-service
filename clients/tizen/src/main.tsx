import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import {API, CatalogDetail, CatalogSource, CatalogTitle, Download, formatBytes, HouseholdItem, HouseholdState, Job, JobLog, LibraryCategory, Release, SubtitleCandidate} from '@filelist/shared';
import {focusElement, useTVNavigation} from './navigation';
import {AVTrack, clampSeek, formatTime, isDownloadComplete, normalizeTrack, parseVTT, playerAction, SubtitleCue, subtitleAt} from './player';
import './tv.css';
import './performance.css';

const STORAGE = 'filelist.serverUrl';
const emptyState: HouseholdState = {favorites: [], continueWatching: [], recent: [], watched: []};

window.FileListBoot?.stage('Rendering interface');

function exitApplication() {
  try {window.tizen?.application?.getCurrentApplication().exit();} catch {}
}

function Player({api, download, resumeMs, onClose, onStateChanged}: {api: API; download: Download; resumeMs: number; onClose: () => void; onStateChanged: () => void}) {
  const [message, setMessage] = useState('Opening stream…');
  const [phase, setPhase] = useState<'opening'|'playing'|'paused'|'buffering'|'waiting'|'failed'>('opening');
  const [position, setPosition] = useState(resumeMs);
  const [total, setTotal] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [tracks, setTracks] = useState<AVTrack[]>([]);
  const [menu, setMenu] = useState<null|'audio'|'subtitles'|'find-subtitles'|'options'|'info'>(null);
  const [subtitleCandidates, setSubtitleCandidates] = useState<SubtitleCandidate[]>([]);
  const [subtitleDelay, setSubtitleDelay] = useState(0);
  const [externalSubtitle, setExternalSubtitle] = useState('');
  const [aspect, setAspect] = useState('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO');
  const [liveDownload, setLiveDownload] = useState(download);
  const current = useRef(resumeMs);
  const duration = useRef(0);
  const lastSaved = useRef(0);
  const session = useRef(0);
  const retryUsed = useRef(false);
  const pollTimer = useRef(0);
  const hideTimer = useRef(0);
  const scrubTimer = useRef(0);
  const scrubTarget = useRef<number|null>(null);
  const controlsVisibleRef = useRef(true);
  const subtitleDelayRef = useRef(0);
  const subtitleCues = useRef<SubtitleCue[]>([]);
  const playing = useRef(false);
  const externalSubtitlePath = useRef('');
  const autoSubtitleAttempted = useRef(false);
  const phaseRef = useRef(phase);
  const menuRef = useRef(menu);
  const lastControlFocus = useRef('play');
  const menuLauncher = useRef('play');
  phaseRef.current = phase;
  menuRef.current = menu;
  controlsVisibleRef.current = controlsVisible;
  subtitleDelayRef.current = subtitleDelay;
  const save = () => {if (duration.current > 0) void api.updatePlayback(download.id, current.current, duration.current).then(onStateChanged).catch(() => {});};

  function stopAVPlay() {
    const av = window.webapis?.avplay;
    try {av?.stop();} catch {}
    try {av?.close();} catch {}
  }

  function revealControls(sticky = false) {
    controlsVisibleRef.current = true;
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    if (!sticky && playing.current && !menuRef.current) hideTimer.current = window.setTimeout(() => {controlsVisibleRef.current=false;setControlsVisible(false);}, 5000);
  }

  function focusControl(key = lastControlFocus.current) {
    window.setTimeout(() => focusElement(document.querySelector<HTMLElement>(`[data-player-control="${key}"]`)), 0);
  }
  function keepControl(key:string, action:()=>void){lastControlFocus.current=key;action();focusControl(key)}

  function openMenu(next: Exclude<typeof menu, null>, launcher: string) {
    menuLauncher.current = launcher;
    lastControlFocus.current = launcher;
    setMenu(next);
    revealControls(true);
    window.setTimeout(() => focusElement(document.querySelector<HTMLElement>('.player-dialog button')), 0);
  }

  function closeMenu() {
    const launcher = menuLauncher.current;
    setMenu(null);
    revealControls();
    focusControl(launcher);
  }

  function seek(target: number) {
    const av = window.webapis?.avplay;
    const next = clampSeek(target, duration.current);
    try {av?.seekTo(next); current.current = next; setPosition(next); revealControls();} catch {}
  }

  function scrub(delta:number){
    const next=clampSeek((scrubTarget.current??current.current)+delta,duration.current);scrubTarget.current=next;setPosition(next);lastControlFocus.current='timeline';revealControls(true);focusControl('timeline');window.clearTimeout(scrubTimer.current);scrubTimer.current=window.setTimeout(()=>{const target=scrubTarget.current;scrubTarget.current=null;if(target!==null)seek(target);focusControl('timeline');},550);
  }

  function refreshTracks(){const av=window.webapis?.avplay;try{const all=(av?.getTotalTrackInfo?.()||[]).map(normalizeTrack);if(all.length)setTracks(all);}catch{}}

  function togglePlayback(force?: boolean) {
    const av = window.webapis?.avplay;
    try {
      const shouldPlay = force ?? !playing.current;
      if (shouldPlay) {av.play(); playing.current = true; setPhase('playing'); setMessage(''); revealControls();}
      else {av.pause(); playing.current = false; setPhase('paused'); setMessage('Paused'); revealControls(true); save();}
    } catch {}
  }

  async function recover(error: string, token: number) {
    if (token !== session.current) return;
    const recoveryToken = ++session.current;
    stopAVPlay();
    let latest = liveDownload;
    try {latest = (await api.downloads()).items.find(item => item.id === download.id) || latest; setLiveDownload(latest);} catch {}
    if (!isDownloadComplete(latest) && !retryUsed.current) {
      playing.current = false;
      setPhase('waiting');
      setMessage('Waiting for the download to finish before retrying playback…');
      revealControls(true);
      const poll = async () => {
        if (recoveryToken !== session.current) return;
        try {
          const next = (await api.downloads()).items.find(item => item.id === download.id);
          if (next) {
            setLiveDownload(next);
            if (isDownloadComplete(next)) {retryUsed.current = true; void openPlayer(current.current); return;}
            setMessage(`Downloading ${Math.round(next.progress * 100)}% · ${formatBytes(next.downloadedBytes)} / ${formatBytes(next.sizeBytes)}${next.speedBytesPerSecond > 0 ? ` · ${formatBytes(next.speedBytesPerSecond)}/s` : ''}${next.etaSeconds > 0 ? ` · ${formatTime(next.etaSeconds * 1000)} left` : ''}`);
          }
        } catch {}
        pollTimer.current = window.setTimeout(poll, 2000);
      };
      pollTimer.current = window.setTimeout(poll, 2000);
      return;
    }
    if (isDownloadComplete(latest) && !retryUsed.current) {retryUsed.current = true; void openPlayer(current.current); return;}
    playing.current = false;
    setPhase('failed');
    setMessage(`Playback failed: ${error}`);
    revealControls(true);
  }

  function openPlayer(startAt: number, shouldPlay = true) {
    const av = window.webapis?.avplay;
    if (!av) {setPhase('failed'); setMessage('AVPlay is unavailable on this device.'); return;}
    window.clearTimeout(pollTimer.current);
    const token = ++session.current;
    stopAVPlay();
    setPhase('opening'); setMessage(retryUsed.current ? 'Download complete. Retrying playback…' : 'Opening stream…'); revealControls(true);
    try {
      av.open(api.streamURL(download.streamUrl));
      av.setDisplayRect(0, 0, 1920, 1080);
      av.setDisplayMethod(aspect);
      if (externalSubtitlePath.current) av.setExternalSubtitlePath(externalSubtitlePath.current);
      av.setListener({
        onbufferingstart: () => {if (token === session.current) {playing.current = false; setPhase('buffering'); setMessage('Buffering…'); revealControls(true);}},
        onbufferingprogress: (progress: number) => {if (token === session.current) setMessage(`Buffering ${progress}%`);},
        onbufferingcomplete: () => {if (token === session.current) {playing.current = true; setPhase('playing'); setMessage(''); refreshTracks(); revealControls();}},
        onstreamcompleted: () => {if (token === session.current) {current.current = duration.current; save(); onClose();}},
        oncurrentplaytime: (value: number) => {if (token === session.current) {current.current = value;if(scrubTarget.current===null)setPosition(value);if(subtitleCues.current.length)setExternalSubtitle(subtitleAt(subtitleCues.current,value,subtitleDelayRef.current));if (Date.now() - lastSaved.current >= 10_000) {lastSaved.current = Date.now(); save();}}},
        onsubtitlechange: (_duration:number, text:string) => {if(token===session.current)setExternalSubtitle(String(text||''));},
        onerror: (error: string) => void recover(error, token),
      });
      av.prepareAsync(() => {
        if (token !== session.current) return;
        duration.current = av.getDuration(); setTotal(duration.current);
        const allTracks = (av.getTotalTrackInfo?.() || []).map(normalizeTrack); setTracks(allTracks);
        if (externalSubtitlePath.current) {try {av.setSilentSubtitle(false);} catch {}}
        else if (isDownloadComplete(liveDownload) && !autoSubtitleAttempted.current) {autoSubtitleAttempted.current = true; void findSubtitles(true,'local');}
        if (startAt > 0 && startAt < duration.current) av.seekTo(clampSeek(startAt, duration.current));
        if (shouldPlay) {av.play(); playing.current = true; setPhase('playing'); setMessage(''); revealControls();}
        else {playing.current = false; setPhase('paused'); setMessage('Paused'); revealControls(true);}
      }, (error: string) => void recover(error || 'AVPlay could not prepare this source.', token));
    } catch (error) {void recover((error as Error).message, token);}
  }

  useEffect(() => {
    openPlayer(resumeMs);
    const focusTimer = window.setTimeout(() => focusElement(document.querySelector<HTMLElement>('[data-player-control="play"]')), 0);
    return () => {session.current++; window.clearTimeout(focusTimer); window.clearTimeout(pollTimer.current); window.clearTimeout(hideTimer.current);window.clearTimeout(scrubTimer.current); save(); stopAVPlay();};
  }, [download.id]);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      const key = target?.dataset.playerControl;
      if (key) lastControlFocus.current = key;
    };
    const key = (event: KeyboardEvent) => {
      const action = playerAction(event.key, event.keyCode);
      if (!action) return;
      event.preventDefault();
      if (action === 'back' || action === 'stop') {if (menuRef.current) closeMenu(); else {save(); onClose();} return;}
      if (action === 'play') {togglePlayback(true); return;}
      if (action === 'pause') {togglePlayback(false); return;}
      if (action === 'play-pause') {togglePlayback(); return;}
      if (action === 'rewind' || action === 'previous') {scrub(-10_000); return;}
      if (action === 'fast-forward' || action === 'next') {scrub(10_000); return;}
      if (!controlsVisibleRef.current && !menuRef.current) {
        revealControls();
        if (action === 'left' || action === 'right') {
          lastControlFocus.current = 'timeline';
          scrub(action === 'left' ? -10_000 : 10_000);
        } else focusControl();
        return;
      }
      revealControls(menuRef.current !== null);
      const selector = menuRef.current ? '.player-dialog button' : '[data-player-control]';
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(element => element.offsetWidth > 0);
      const active = document.activeElement as HTMLElement | null;
      if (action === 'enter') {if (active && elements.includes(active)) active.click(); else focusElement(elements[0] || null); return;}
      if (!menuRef.current && active?.dataset.playerControl === 'timeline' && (action === 'left' || action === 'right')) {
        scrub(action === 'left' ? -10_000 : 10_000);
        return;
      }
      if (action === 'up' && !menuRef.current) {focusElement(document.querySelector<HTMLElement>('[data-player-control="timeline"]')); return;}
      if (action === 'down' && !menuRef.current) {focusControl(lastControlFocus.current === 'timeline' ? 'play' : lastControlFocus.current); return;}
      const index = Math.max(0, elements.indexOf(active || elements[0]));
      const delta = action === 'left' || action === 'up' ? -1 : 1;
      focusElement(elements[Math.max(0, Math.min(elements.length - 1, index + delta))] || null);
    };
    addEventListener('focusin', remember);
    addEventListener('keydown', key);
    return () => {removeEventListener('focusin', remember); removeEventListener('keydown', key);};
  }, [download.id]);

  function chooseTrack(type: 'AUDIO'|'TEXT', index: number | null) {
    const av = window.webapis?.avplay;
    try {if (type === 'TEXT' && index === null) {av.setSilentSubtitle(true);subtitleCues.current=[];setExternalSubtitle('');} else {if (type === 'TEXT') {av.setSilentSubtitle(false);subtitleCues.current=[];setExternalSubtitle('');} av.setSelectTrack(type, index);if(type==='AUDIO'){const wasPlaying=playing.current;if(!wasPlaying)av.play();window.setTimeout(()=>{try{av.seekTo(clampSeek(current.current,duration.current));if(!wasPlaying)av.pause();refreshTracks();}catch{}},120);}}} catch {}
    closeMenu();
  }
  async function findSubtitles(automatic = false, scope:'local'|'remote'|'all' = 'remote') {
    if (!automatic && scope === 'remote') openMenu('find-subtitles', 'subtitles');
    setMessage(scope==='local'?'Checking included subtitles…':'Searching for Romanian subtitles…');
    try {
      const page = await api.subtitles(download.id, 'ro', scope);
      const candidates = page.items;
      setSubtitleCandidates(candidates);
      if (automatic && candidates.length > 0) {await installSubtitle(candidates[0]); return;}
      setMessage(candidates.length > 0 ? '' : page.warnings?.length?page.warnings.map(w=>`${w.provider}: ${w.message}`).join(' · '):automatic?'No included subtitle was found.':'No matching online subtitles were found.');
    } catch (error) {setMessage(`Subtitle search failed: ${(error as Error).message}`);}
  }
  async function installSubtitle(candidate: SubtitleCandidate) {
    setMessage(`Preparing ${candidate.title}…`); setMenu(null); revealControls(true);
    try {
      const asset = await api.prepareSubtitle(download.id, candidate.provider, candidate.id, 'vtt');
      const response=await fetch(api.streamURL(asset.url));if(!response.ok)throw new Error(`server returned ${response.status}`);const cues=parseVTT(await response.text());if(!cues.length)throw new Error('the downloaded subtitle contained no readable cues');subtitleCues.current=cues;externalSubtitlePath.current='';try{window.webapis?.avplay.setSilentSubtitle(true);}catch{}setExternalSubtitle(subtitleAt(cues,current.current,subtitleDelayRef.current));setMessage(`${candidate.language||'Subtitle'} selected`);revealControls();
    } catch (error) {setMessage(`Subtitle preparation failed: ${(error as Error).message}`);}
  }
  function changeDelay(delta: number) {const next = Math.max(-10_000, Math.min(10_000, subtitleDelay + delta)); setSubtitleDelay(next); try {window.webapis?.avplay.setSubtitlePosition(next);} catch {}}
  function changeAspect(value: string) {setAspect(value); try {window.webapis?.avplay.setDisplayMethod(value);} catch {}}
  const percent = total > 0 ? Math.min(100, position / total * 100) : liveDownload.progress * 100;
  const audioTracks = tracks.filter(track => track.type === 'AUDIO');
  const subtitleTracks = tracks.filter(track => track.type === 'TEXT');
  return <div class="player-shell"><object id="av-player" type="application/avplayer"></object><div class={`player ${controlsVisible ? 'controls-visible' : ''}`}>
    {externalSubtitle&&<div class="external-subtitle">{externalSubtitle}</div>}
    {message && <div class="player-message" aria-live="polite">{message}</div>}
    <div class="player-controls">
      <div class="player-title">{download.filePath}</div>
      <button class="player-timeline" data-player-control="timeline" onClick={() => {lastControlFocus.current='timeline';revealControls(true);focusControl('timeline')}} aria-label="Playback timeline; use left and right to seek"><span style={{width:`${percent}%`}}></span></button>
      <div class="player-time"><span>{formatTime(position)}</span><span>{formatTime(total)}</span></div>
      <div class="player-toolbar">
        <button data-player-control="restart" onClick={() => keepControl('restart',()=>seek(0))}>Restart</button><button data-player-control="back-10" onClick={() => keepControl('back-10',()=>seek(current.current - 10_000))}>−10s</button>
        <button data-player-control="play" class="primary" onClick={() => keepControl('play',()=>togglePlayback())}>{playing.current ? 'Pause' : 'Play'}</button><button data-player-control="forward-10" onClick={() => keepControl('forward-10',()=>seek(current.current + 10_000))}>+10s</button>
        <button data-player-control="audio" onClick={() => openMenu('audio', 'audio')}>Audio ({audioTracks.length})</button><button data-player-control="subtitles" onClick={() => {openMenu('subtitles','subtitles');void findSubtitles(false,'local')}}>Subtitles ({subtitleTracks.length+subtitleCandidates.length})</button>
        <button data-player-control="options" onClick={() => openMenu('options', 'options')}>Options</button><button data-player-control="back" onClick={() => {save(); onClose();}}>Back</button>
      </div>
      {phase === 'failed' && <button class="player-retry" data-player-control="retry" onClick={() => {retryUsed.current = false; openPlayer(current.current);}}>Retry playback</button>}
    </div>
    {menu && <div class="player-dialog">
      {menu === 'audio' && <><h2>Audio track</h2><button onClick={refreshTracks}>Refresh tracks</button>{audioTracks.map(track => <button onClick={() => chooseTrack('AUDIO', track.index)}>{track.label}</button>)}</>}
      {menu === 'subtitles' && <><h2>Subtitles</h2><button onClick={() => chooseTrack('TEXT', null)}>Off</button>{subtitleCandidates.map((candidate,index)=><button onClick={()=>void installSubtitle(candidate)}><strong>{candidate.fileName||candidate.title||`Included subtitle ${index+1}`}</strong><br/><small>{[candidate.language||'Language unavailable',candidate.providerLabel||candidate.provider,candidate.format].filter(Boolean).join(' · ')}</small></button>)}{subtitleTracks.length>0&&<><h3>Native AVPlay fallback</h3>{subtitleTracks.map(track => <button onClick={() => chooseTrack('TEXT', track.index)}>{track.label}</button>)}</>}<button onClick={() => void findSubtitles(false,'remote')}>Find online subtitles…</button></>}
      {menu === 'find-subtitles' && <><h2>Download subtitles</h2>{subtitleCandidates.length === 0 ? <p>No matching provider subtitles are available.</p> : subtitleCandidates.map((candidate,index) => <button onClick={() => void installSubtitle(candidate)}><strong>{candidate.fileName||candidate.title||`Subtitle ${index+1}`}</strong><br/><small>{[candidate.language||'Language unavailable',candidate.providerLabel||candidate.provider,candidate.format||'format unavailable',candidate.hearingImpaired?'hearing impaired':''].filter(Boolean).join(' · ')}</small>{candidate.releaseName&&<><br/><small>{candidate.releaseName}</small></>}</button>)}</>}
      {menu === 'options' && <><h2>Playback options</h2><button onClick={() => changeDelay(-500)}>Subtitle earlier (−0.5s)</button><button onClick={() => changeDelay(500)}>Subtitle later (+0.5s)</button><button onClick={() => changeDelay(-subtitleDelay)}>Reset subtitle delay ({subtitleDelay / 1000}s)</button><button onClick={() => changeAspect('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO')}>Aspect: Auto</button><button onClick={() => changeAspect('PLAYER_DISPLAY_MODE_LETTER_BOX')}>Aspect: Letterbox</button><button onClick={() => changeAspect('PLAYER_DISPLAY_MODE_FULL_SCREEN')}>Aspect: Full screen</button><button onClick={() => setMenu('info')}>Playback information</button></>}
      {menu === 'info' && <><h2>Playback information</h2><p>{download.mimeType}</p><p>{formatBytes(download.sizeBytes)} · {tracks.length} tracks</p><p>{formatTime(position)} / {formatTime(total)} · {aspect.replace('PLAYER_DISPLAY_MODE_','')}</p><button onClick={() => setMenu('options')}>Back to options</button></>}
      <button onClick={closeMenu}>Close</button>
    </div>}
  </div></div>;
}

function Setup({draft, server, status, onDraft, onConnect, onForget}: {draft: string; server: string; status: string; onDraft: (value: string) => void; onConnect: () => void; onForget: () => void}) {
  const address = useRef<HTMLInputElement>(null);
  const connect = useRef<HTMLButtonElement>(null);
  useTVNavigation({getInitialFocus: () => connect.current, inputExitTarget: () => connect.current, onBack: exitApplication});
  return <main class="setup"><h1>FileList TV</h1><p>Enter the private-LAN server address.</p><div class="setup-controls"><input ref={address} readOnly data-focus-key="setup-address" type="url" inputMode="url" autoComplete="off" spellcheck={false} value={draft} onInput={event => onDraft(event.currentTarget.value)} placeholder="http://server.lan:8097"/><button ref={connect} data-focus-key="setup-connect" class="primary" onClick={onConnect}>Connect</button></div><p class="focus-hint">Select the address and press OK to open the keyboard. Select Connect and press OK when ready.</p><p aria-live="polite">{status}</p>{server && <button data-focus-key="setup-forget" onClick={onForget}>Forget server</button>}</main>;
}

type TVRoute = 'home'|'search'|'library'|'continue'|'favorites'|'watched'|'downloads'|'library-categories'|'tracker'|'browse'|'recent'|'categories'|'jobs'|'events'|'settings';
const menuGroups: Array<{label:string; items:Array<{id:TVRoute; label:string; icon:string}>}> = [
  {label:'',items:[{id:'home',label:'Home',icon:'⌂'},{id:'search',label:'Search',icon:'⌕'}]},
  {label:'My Library',items:[{id:'library',label:'Dashboard',icon:'◫'},{id:'continue',label:'Continue watching',icon:'▶'},{id:'favorites',label:'Favorites',icon:'★'},{id:'watched',label:'Watched',icon:'✓'},{id:'downloads',label:'Downloads',icon:'↓'},{id:'library-categories',label:'Categories',icon:'≡'}]},
  {label:'Tracker',items:[{id:'tracker',label:'Dashboard',icon:'◉'},{id:'browse',label:'Browse',icon:'▦'},{id:'recent',label:'Recently added',icon:'+'},{id:'categories',label:'Categories',icon:'≡'}]},
  {label:'',items:[{id:'jobs',label:'Jobs',icon:'↻'},{id:'events',label:'Events',icon:'!'},{id:'settings',label:'Settings',icon:'⚙'}]},
];

function Catalog({api,status,titles,household,downloads,jobs,restoreFocus,onFocus,onRetry,onChangeServer,onForgetServer,onPlay,onPlayDownload,onManageDownload,onFavorite}: {api:API; status:string; titles:CatalogTitle[]; household:HouseholdState; downloads:Download[]; jobs:Job[]; restoreFocus:string|null; onFocus:(key:string)=>void; onRetry:()=>void; onChangeServer:()=>void; onForgetServer:()=>void; onPlay:(release:Release,fileIndex?:number,resumeMs?:number)=>void; onPlayDownload:(download:Download)=>void; onManageDownload:(download:Download,action:string,deleteFiles?:boolean)=>void; onFavorite:(title:CatalogTitle,value:boolean)=>void}) {
  const [route,setRoute]=useState<TVRoute>('home');
  const [menuOpen,setMenuOpen]=useState(false);
  const [draftQuery,setDraftQuery]=useState('');
  const [query,setQuery]=useState('');
  const [searching,setSearching]=useState(false);
  const [category,setCategory]=useState('');
  const [sort,setSort]=useState<'newest'|'seeders'|'title'|'rating'>('newest');
  const [remoteTitles,setRemoteTitles]=useState(titles.slice(0,12));
  const [pageCursor,setPageCursor]=useState('');
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [previousCursors,setPreviousCursors]=useState<string[]>([]);
  const [pageNumber,setPageNumber]=useState(1);
  const [detail,setDetail]=useState<CatalogDetail|null>(null);
  const [detailMessage,setDetailMessage]=useState('');
  const first=useRef<HTMLButtonElement>(null);
  const lastContent=useRef<string|null>(restoreFocus);
  const favoriteIDs=new Set(household.favorites.map(item=>item.catalog?.id).filter(Boolean));
  useEffect(()=>setRemoteTitles(current=>current.map(item=>titles.find(updated=>updated.id===item.id)||item)),[titles]);
  const fetchPage=(cursor='',remember=false)=>api.titles({search:query.trim().length>=3?query.trim():undefined,category,sort,pageSize:12,cursor}).then(page=>{if(remember)setPreviousCursors(current=>[...current,pageCursor].slice(-20));setPageCursor(cursor);setRemoteTitles(page.items);setNextCursor(page.nextCursor);void api.ensureMetadata(page.items.map(item=>item.id));return page;});
  useEffect(()=>{setPreviousCursors([]);setPageNumber(1);void fetchPage('').catch(()=>{})},[query,category,sort]);
  useEffect(()=>{const refresh=(event:Event)=>{const searched=String((event as CustomEvent).detail?.query||'').toLowerCase();if(query&&searched===query.toLowerCase()){setDetailMessage('FileList search completed.');void fetchPage('').catch(error=>setDetailMessage((error as Error).message));}};window.addEventListener('catalog-search-completed',refresh);return()=>window.removeEventListener('catalog-search-completed',refresh)},[query,category,sort]);
  const submitSearch=async()=>{const value=draftQuery.trim();setSearching(true);try{if(value){const page=await api.searchTitles(value);setRemoteTitles(page.items);setNextCursor(page.nextCursor);void api.ensureMetadata(page.items.map(item=>item.id)).catch(()=>{});}setQuery(value);setPreviousCursors([]);setPageNumber(1);}catch(error){setDetailMessage((error as Error).message);}finally{setSearching(false)}};
  const nextPage=()=>{if(!nextCursor)return;void fetchPage(nextCursor,true).then(()=>setPageNumber(value=>value+1)).catch(()=>{})};
  const previousPage=()=>{const cursor=previousCursors[previousCursors.length-1];if(cursor===undefined)return;setPreviousCursors(current=>current.slice(0,-1));void fetchPage(cursor).then(()=>setPageNumber(value=>Math.max(1,value-1))).catch(()=>{})};
  const openTitle=async(title:CatalogTitle)=>{setDetailMessage('Loading versions…');try{setDetail(await api.title(title.id));setDetailMessage('');}catch(error){setDetailMessage((error as Error).message);}};
  const chooseRoute=(next:TVRoute)=>{setRoute(next);setDetail(null);setMenuOpen(false);window.setTimeout(()=>focusElement(document.querySelector<HTMLElement>('[data-focus-region="content"]')),0);};
  const onBack=()=>{if(detail){setDetail(null);window.setTimeout(()=>focusElement(document.querySelector<HTMLElement>(lastContent.current?`[data-focus-key="${lastContent.current}"]`:'[data-focus-region="content"]')),0);return;}if(menuOpen){setMenuOpen(false);window.setTimeout(()=>focusElement(lastContent.current?document.querySelector<HTMLElement>(`[data-focus-key="${lastContent.current}"]`):document.querySelector<HTMLElement>('[data-focus-region="content"]')),0);return;}setMenuOpen(true);window.setTimeout(()=>focusElement(document.querySelector<HTMLElement>(`[data-menu-route="${route}"]`)),0);};
  useTVNavigation({getInitialFocus:()=>first.current||document.querySelector<HTMLElement>('[data-focus-region="content"]'),restoreKey:restoreFocus,onFocusKey:key=>{onFocus(key);if(document.activeElement instanceof HTMLElement&&document.activeElement.dataset.focusRegion==='content')lastContent.current=key;},onBack,onLongBack:exitApplication,onDirection:(direction,current)=>{
    if(detail)return false;
	if(route==='events'&&current.dataset.focusKey==='event-latest'&&direction==='down'){focusElement(document.querySelector<HTMLElement>('[data-focus-key="event-rebuild"]'));return true;}
	if(route==='events'&&current.dataset.focusKey==='event-rebuild'&&direction==='up'){focusElement(document.querySelector<HTMLElement>('[data-focus-key="event-latest"]'));return true;}
    const region=current.dataset.focusRegion;
    if(region==='content'&&direction==='left'&&current.dataset.focusCol==='0'){setMenuOpen(true);window.setTimeout(()=>focusElement(document.querySelector<HTMLElement>(`[data-menu-route="${route}"]`)||document.querySelector<HTMLElement>('[data-focus-region="sidebar"]')),0);return true;}
    if(region==='sidebar'&&direction==='right'){setMenuOpen(false);window.setTimeout(()=>focusElement(lastContent.current?document.querySelector<HTMLElement>(`[data-focus-key="${lastContent.current}"]`):document.querySelector<HTMLElement>('[data-focus-region="content"]')),0);return true;}
    return false;
  }});
  const householdFor=(name:string)=>name==='continue'?household.continueWatching:name==='favorites'?household.favorites:name==='watched'?household.watched:name==='recent'?household.recent:[];
  const routeHousehold=householdFor(route);
  let visible=remoteTitles;
  if(category)visible=visible.filter(title=>title.categories.includes(category));
  if(sort==='seeders')visible=[...visible].sort((a,b)=>b.bestSeeders-a.bestSeeders);if(sort==='title')visible=[...visible].sort((a,b)=>a.title.localeCompare(b.title));if(sort==='rating')visible=[...visible].sort((a,b)=>Number(Boolean(b.ratingVotes))-Number(Boolean(a.ratingVotes))||(b.rating||0)-(a.rating||0));
  if(route==='favorites'||route==='continue'||route==='watched')visible=routeHousehold.map(item=>item.catalog).filter((title):title is CatalogTitle=>Boolean(title));
  const heading=menuGroups.flatMap(group=>group.items).find(item=>item.id===route)?.label||'Home';
  const hero=visible[0]||titles[0];
  const rows: Array<{key:string;title:string;items:CatalogTitle[]}> = route==='home' ? [
    {key:'new',title:'Recently added',items:titles.slice(0,12)},
    {key:'popular',title:'Well seeded',items:[...titles].sort((a,b)=>b.bestSeeders-a.bestSeeders).slice(0,12)},
  ] : route==='tracker' ? [{key:'tracker-new',title:'Recently added',items:visible.slice(0,6)},{key:'tracker-seeded',title:'Strong swarms',items:[...visible].sort((a,b)=>b.bestSeeders-a.bestSeeders).slice(0,6)}] : ['continue','watched','library','downloads','library-categories','jobs','events','settings','categories'].includes(route) ? [] : [{key:route,title:heading,items:visible.slice(0,12)}];
  if(detail)return <TitleDetail api={api} detail={detail} message={detailMessage} favorite={favoriteIDs.has(detail.title.id)} onClose={onBack} onFavorite={onFavorite} onPlay={onPlay}/>;
  return <div class={`tv-app ${menuOpen?'menu-open':''}`}>
    <aside class="tv-sidebar"><div class="tv-brand"><span>FL</span><b>FileList TV</b></div>{menuGroups.map((group,groupIndex)=><div class="tv-menu-group">{group.label&&<small>{group.label}</small>}{group.items.map((item,index)=><button data-menu-route={item.id} data-focus-region="sidebar" data-focus-row={groupIndex*10+index} data-focus-col="0" data-focus-key={`menu-${item.id}`} class={route===item.id?'active':''} onClick={()=>chooseRoute(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}</div>)}</aside>
    <main class="tv-content">
      <header class="tv-top"><div><small>{route==='home'?'PRIVATE SCREENING ARCHIVE':'FILELIST TV'}</small><h1>{heading}</h1></div><span aria-live="polite">{status}</span><button data-focus-region="content" data-focus-row="0" data-focus-col="0" data-focus-key="header-retry" onClick={onRetry}>Refresh</button></header>
      {route==='search'&&<div class="tv-search"><input readOnly data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="search-input" value={draftQuery} onInput={event=>setDraftQuery(event.currentTarget.value)} placeholder="Search FileList; press OK to type"/><button data-focus-region="content" data-focus-row="1" data-focus-col="1" data-focus-key="search-submit" class="primary" disabled={searching} onClick={()=>void submitSearch()}>{searching?'Searching…':'Search'}</button>{query&&<button data-focus-region="content" data-focus-row="1" data-focus-col="2" data-focus-key="search-clear" onClick={()=>{setDraftQuery('');setQuery('')}}>Clear</button>}</div>}
      {['tracker','browse','recent','categories','search'].includes(route)&&<div class="tv-filters"><button data-focus-region="content" data-focus-row="2" data-focus-col="0" data-focus-key="sort-newest" class={sort==='newest'?'active':''} onClick={()=>setSort('newest')}>Newest</button><button data-focus-region="content" data-focus-row="2" data-focus-col="1" data-focus-key="sort-seeders" class={sort==='seeders'?'active':''} onClick={()=>setSort('seeders')}>Most seeded</button><button data-focus-region="content" data-focus-row="2" data-focus-col="2" data-focus-key="sort-rating" class={sort==='rating'?'active':''} onClick={()=>setSort('rating')}>Rating</button><button data-focus-region="content" data-focus-row="2" data-focus-col="3" data-focus-key="sort-title" class={sort==='title'?'active':''} onClick={()=>setSort('title')}>A–Z</button>{category&&<button data-focus-region="content" data-focus-row="2" data-focus-col="4" data-focus-key="clear-category" onClick={()=>setCategory('')}>Clear {category}</button>}</div>}
      {route==='settings'?<TVSettings api={api} onChangeServer={onChangeServer} onForgetServer={onForgetServer}/>:route==='events'?<TVEvents api={api}/>:route==='downloads'?<TVDownloads items={downloads} onPlay={onPlayDownload} onManage={onManageDownload}/>:route==='library-categories'?<TVLibraryCategories api={api} onPlay={onPlay}/>:route==='jobs'?<TVJobs api={api} items={jobs}/>:route==='categories'?<section class="tv-category-grid">{Array.from(new Set(titles.flatMap(title=>title.categories))).sort().map((name,index)=><button data-focus-region="content" data-focus-row={3+Math.floor(index/4)} data-focus-col={index%4} data-focus-key={`category-${name}`} onClick={()=>{setCategory(name);setRoute('browse')}}><strong>{name}</strong><span>Browse titles</span></button>)}</section>:<>
        {route==='home'&&hero&&<section class="tv-hero" style={hero.backdropUrl?{backgroundImage:`linear-gradient(90deg,#090d10 3%,rgba(9,13,16,.82) 42%,rgba(9,13,16,.15)),url(${api.streamURL(hero.backdropUrl)})`}:undefined}><div><span class="eyebrow">{hero.kind==='series'?'Series':'Movie'} · {hero.year||'Year unknown'}</span><h2>{hero.title}</h2><p>{hero.overview||`${hero.sourceCount} available version${hero.sourceCount===1?'':'s'} · up to ${hero.bestSeeders} seeders`}</p><button ref={first} data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key={`hero-${hero.id}`} class="primary" onClick={()=>void openTitle(hero)}>View versions</button></div></section>}
        {(route==='home'||route==='continue'||route==='watched'||route==='library')&&
          <HouseholdRail api={api} title={route==='watched'?'Watched':'Continue watching'} items={route==='watched'?household.watched:household.continueWatching} row={3} onPlay={onPlay}/>
        }
        {route==='library'&&
          <HouseholdRail api={api} title="Favorites" items={household.favorites} row={4} onPlay={onPlay}/>
        }
        <div class="tv-rows">{rows.filter(row=>row.items.length>0).map((row,rowIndex)=><section><div class="row-heading"><h2>{row.title}</h2><span>{row.items.length} titles</span></div><div class="poster-rail">{row.items.map((title,col)=><TitleCard api={api} title={title} row={rowIndex+10} col={col} focusRef={!hero&&rowIndex===0&&col===0?first:undefined} onOpen={()=>void openTitle(title)}/>)}</div></section>)}</div>
        {['search','browse','recent'].includes(route)&&<nav class="tv-pager" aria-label="Catalog pages"><button disabled={previousCursors.length===0} data-focus-region="content" data-focus-row="90" data-focus-col="0" data-focus-key="page-previous" onClick={previousPage}>Previous</button><span>Page {pageNumber}</span><button disabled={!nextCursor} data-focus-region="content" data-focus-row="90" data-focus-col="1" data-focus-key="page-next" onClick={nextPage}>Next</button></nav>}
        {rows.every(row=>row.items.length===0)&&!['continue','watched'].includes(route)&&<div class="tv-empty"><h2>Nothing here yet</h2><p>Try another section or refresh the catalog.</p></div>}
      </>}
    </main>
  </div>;
}

function HouseholdRail({api,title,items,row,onPlay}:{api:API;title:string;items:HouseholdState['continueWatching'];row:number;onPlay:(release:Release,fileIndex?:number,resumeMs?:number)=>void}){
  if(items.length===0)return <section><div class="row-heading"><h2>{title}</h2></div><p class="tv-muted">Nothing here yet.</p></section>;
  return <section><div class="row-heading"><h2>{title}</h2><span>{items.length} item{items.length===1?'':'s'}</span></div><div class="poster-rail">{items.map((item,col)=>{
    const label=item.catalog?.title||item.release.name;
    const progress=item.durationMs>0?Math.max(0,Math.min(100,Math.round(item.positionMs/item.durationMs*100))):0;
    const metadata=[item.catalog?.year,item.catalog?.resolutions?.[0],item.release.category].filter(Boolean).join(' · ');
    const status=item.watched?'Watched':item.positionMs>0?`${progress}% watched`:'Ready to play';
    return <button class="poster-card library-poster-card" data-focus-region="content" data-focus-row={row} data-focus-col={col} data-focus-key={`resume-${item.sourceId||item.release.id}-${col}`} onClick={()=>onPlay(item.release,item.fileIndex,item.watched?0:item.positionMs)}>{item.catalog?.posterUrl?<img src={api.streamURL(item.catalog.posterUrl)} alt="" loading="lazy"/>:<div class="poster-fallback">{label.slice(0,1)}</div>}<div class="poster-copy"><strong>{label}</strong><span>{metadata||status}</span><small>{metadata?status:item.filePath||item.release.name}</small></div>{item.positionMs>0&&!item.watched&&<i class="tv-card-progress" aria-label={`${progress}% watched`}><b style={{width:`${progress}%`}}/></i>}</button>
  })}</div></section>
}

function TVDownloads({items,onPlay,onManage}:{items:Download[];onPlay:(download:Download)=>void;onManage:(download:Download,action:string,deleteFiles?:boolean)=>void}){
  const[pending,setPending]=useState<{download:Download;deleteFiles:boolean}|null>(null);
  if(pending)return <section class="tv-settings tv-removal-confirm"><h2>{pending.deleteFiles?'Delete torrent and files?':'Remove torrent from qBittorrent?'}</h2><strong>{pending.download.releaseName||pending.download.filePath}</strong><p>Selected file: {pending.download.filePath}</p><p>{formatBytes(pending.download.sizeBytes)} · FileList release {pending.download.releaseId}</p><p>{pending.deleteFiles?'The downloaded files will be permanently deleted.':'The downloaded files will remain on disk.'}</p><button data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="download-cancel" onClick={()=>setPending(null)}>Cancel</button><button class={pending.deleteFiles?'danger-button':'primary'} data-focus-region="content" data-focus-row="2" data-focus-col="0" data-focus-key="download-confirm" onClick={()=>{onManage(pending.download,'remove',pending.deleteFiles);setPending(null)}}>{pending.deleteFiles?'Delete torrent and files':'Remove torrent only'}</button></section>;
  return <section class="tv-list"><h2>Application downloads</h2>{items.length===0?<p>No managed downloads yet.</p>:items.map((download,index)=><article class="tv-download-row"><div><strong>{download.displayTitle||download.filePath}</strong><span class="tv-release-name">{download.releaseName||download.filePath}</span><small>{[download.parsed?.resolution,download.parsed?.source,download.parsed?.videoCodec,download.parsed?.audio,download.category].filter(Boolean).join(' · ')||'Source details unavailable'}</small><small>Selected: {download.filePath} · index {download.fileIndex} · {formatBytes(download.sizeBytes)}</small><small>FileList release {download.releaseId} · {download.trackerSeeders??'—'} tracker seeders{download.releaseSizeBytes?` · ${formatBytes(download.releaseSizeBytes)} total`:''}</small><span>{download.state} · {(download.progress*100).toFixed(1)}% · {formatBytes(download.downloadedBytes)} / {formatBytes(download.sizeBytes)}</span><small>{formatBytes(download.speedBytesPerSecond)}/s · {download.seeds} connected seeds · {download.peers} peers</small></div><div><button data-focus-region="content" data-focus-row={1+index} data-focus-col="0" data-focus-key={`download-${download.id}-play`} class="primary" onClick={()=>onPlay(download)}>Play</button><button data-focus-region="content" data-focus-row={1+index} data-focus-col="1" data-focus-key={`download-${download.id}-toggle`} onClick={()=>onManage(download,download.state==='pausedUP'?'resume':'pause')}>{download.state==='pausedUP'?'Resume':'Pause'}</button><button data-focus-region="content" data-focus-row={1+index} data-focus-col="2" data-focus-key={`download-${download.id}-remove`} onClick={()=>setPending({download,deleteFiles:false})}>Remove</button><button data-focus-region="content" data-focus-row={1+index} data-focus-col="3" data-focus-key={`download-${download.id}-delete`} onClick={()=>setPending({download,deleteFiles:true})}>Delete files</button></div></article>)}</section>
}
function TVLibraryCategories({api,onPlay}:{api:API;onPlay:(release:Release,fileIndex?:number,resumeMs?:number)=>void}){const[categories,setCategories]=useState<LibraryCategory[]>([]);const[items,setItems]=useState<HouseholdItem[]>([]);const[selected,setSelected]=useState('');const[message,setMessage]=useState('Loading library categories…');useEffect(()=>{api.libraryCategories().then(page=>{setCategories(page.items as LibraryCategory[]);setMessage('')}).catch(error=>setMessage(error.message))},[]);async function open(name:string){setSelected(name);setMessage('Loading category…');try{const page=await api.libraryCategories(name);setItems(page.items as HouseholdItem[]);setMessage('')}catch(error){setMessage((error as Error).message)}}if(selected)return <section><button data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="library-category-back" onClick={()=>{setSelected('');setItems([])}}>All categories</button><div class="row-heading"><h2>{selected}</h2><span>{items.length} item{items.length===1?'':'s'}</span></div>{message&&<p aria-live="polite">{message}</p>}<div class="tv-library-grid">{items.map((item,index)=><button class="poster-card" data-focus-region="content" data-focus-row={2+Math.floor(index/5)} data-focus-col={index%5} data-focus-key={`library-item-${item.sourceId||item.release.id}`} onClick={()=>onPlay(item.release,item.fileIndex,item.watched?0:item.positionMs)}>{item.catalog?.posterUrl?<img src={api.streamURL(item.catalog.posterUrl)} alt="" loading="lazy"/>:<div class="poster-fallback">{(item.catalog?.title||item.release.name).slice(0,1)}</div>}<div class="poster-copy"><strong>{item.catalog?.title||item.release.name}</strong><span>{[item.catalog?.year,item.catalog?.resolutions?.[0],item.release.category].filter(Boolean).join(' · ')}</span><small>{item.watched?'Watched':item.positionMs>0?'Resume playback':`${item.release.seeders} seeders`}</small></div></button>)}</div>{items.length===0&&!message&&<p class="tv-muted">No media remains in this category.</p>}</section>;return <section class="tv-category-grid">{message&&<p aria-live="polite">{message}</p>}{categories.map((category,index)=><button data-focus-region="content" data-focus-row={1+Math.floor(index/4)} data-focus-col={index%4} data-focus-key={`library-category-${category.name}`} onClick={()=>void open(category.name)}><strong>{category.name}</strong><span>{category.count} item{category.count===1?'':'s'}</span></button>)}</section>}
function TVJobs({api,items:initial}:{api:API;items:Job[]}){
  const[items,setItems]=useState(initial);const[query,setQuery]=useState('');const[state,setState]=useState('');const[kind,setKind]=useState('');const[retryable,setRetryable]=useState('');const[updatedHours,setUpdatedHours]=useState('');const[cursor,setCursor]=useState('');const[next,setNext]=useState<string|null>(null);const[history,setHistory]=useState<string[]>([]);const[message,setMessage]=useState('');const[detail,setDetail]=useState<{job:Job;logs:JobLog[];next:string|null}|null>(null);
  async function load(target='',remember=false){try{const page=await api.jobs({search:query,state,kind,retryable,updatedHours,pageSize:12,cursor:target});if(remember)setHistory(value=>[...value,cursor]);setCursor(target);setItems(page.items);setNext(page.nextCursor)}catch(error){setMessage((error as Error).message)}}
  async function open(job:Job){try{const[result,logs]=await Promise.all([api.job(job.id),api.jobLogs(job.id)]);setDetail({job:result.job,logs:logs.items,next:logs.nextCursor})}catch(error){setMessage((error as Error).message)}}
  async function older(){if(!detail?.next)return;try{const page=await api.jobLogs(detail.job.id,detail.next);setDetail({...detail,logs:[...detail.logs,...page.items],next:page.nextCursor})}catch(error){setMessage((error as Error).message)}}
  useEffect(()=>{const timer=window.setTimeout(()=>{setHistory([]);void load('')},400);return()=>clearTimeout(timer)},[query,state,kind,retryable,updatedHours]);
  if(detail)return <TVJobDetail detail={detail} onBack={()=>setDetail(null)} onOlder={older}/>;
  const cycle=(value:string,values:string[],set:(value:string)=>void)=>set(values[(values.indexOf(value)+1)%values.length]);
  return <section class="tv-list"><h2>Background jobs</h2><div class="tv-filters"><input readOnly data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="jobs-search" value={query} onInput={event=>setQuery(event.currentTarget.value)} placeholder="Search; press OK to type"/><button data-focus-region="content" data-focus-row="1" data-focus-col="1" data-focus-key="jobs-state" onClick={()=>cycle(state,['','failed','completed','running','queued'],setState)}>State: {state||'all'}</button><button data-focus-region="content" data-focus-row="1" data-focus-col="2" data-focus-key="jobs-kind" onClick={()=>cycle(kind,['','metadata','catalog-title-refresh','catalog-sync'],setKind)}>Kind: {kind||'all'}</button><button data-focus-region="content" data-focus-row="1" data-focus-col="3" data-focus-key="jobs-retry" onClick={()=>cycle(retryable,['','true','false'],setRetryable)}>Retry: {retryable||'any'}</button><button data-focus-region="content" data-focus-row="1" data-focus-col="4" data-focus-key="jobs-time" onClick={()=>cycle(updatedHours,['','24','168','720'],setUpdatedHours)}>Updated: {updatedHours?`${updatedHours}h`:'any'}</button></div>{message&&<p>{message}</p>}{items.length===0?<p>No matching jobs.</p>:items.map((job,index)=><article><div><strong>{job.label||job.kind}</strong><span>{job.state} · {(job.progress*100).toFixed(0)}%</span><small>{job.id} · {job.error||job.nextAttemptAt&&`retry ${new Date(job.nextAttemptAt).toLocaleString()}`||new Date(job.updatedAt).toLocaleString()}</small></div><div><button data-focus-region="content" data-focus-row={2+index} data-focus-col="0" data-focus-key={`job-${job.id}`} onClick={()=>void open(job)}>Details</button><button disabled={job.state==='queued'||job.state==='running'||job.state==='retry_wait'} data-focus-region="content" data-focus-row={2+index} data-focus-col="1" data-focus-key={`job-${job.id}-retry`} onClick={()=>void api.retryJob(job.id).then(()=>{setMessage('Job queued again.');void load(cursor)}).catch(error=>setMessage(error.message))}>Retry</button></div></article>)}<nav class="tv-pager"><button disabled={history.length===0} data-focus-region="content" data-focus-row="90" data-focus-col="0" data-focus-key="jobs-previous" onClick={()=>{const target=history[history.length-1]||'';setHistory(value=>value.slice(0,-1));void load(target)}}>Previous</button><button disabled={!next} data-focus-region="content" data-focus-row="90" data-focus-col="1" data-focus-key="jobs-next" onClick={()=>next&&void load(next,true)}>Next</button></nav></section>
}

function TVJobDetail({detail,onBack,onOlder}:{detail:{job:Job;logs:JobLog[];next:string|null};onBack:()=>void;onOlder:()=>void}){
  const[level,setLevel]=useState('');const[attempt,setAttempt]=useState('');const[expanded,setExpanded]=useState<number|null>(null);
  const logs=detail.logs.filter(log=>(!level||log.level===level)&&(!attempt||String(log.attempt)===attempt));
  return <section class="tv-list job-detail"><button data-focus-region="content" data-focus-row="0" data-focus-col="0" data-focus-key="job-detail-back" onClick={onBack}>← Jobs</button><h2>{detail.job.label}</h2><p>{detail.job.state} · attempt {detail.job.attempt}</p><div class="tv-filters"><button data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="log-level" onClick={()=>setLevel(value=>value===''?'error':value==='error'?'warn':'')}>Level: {level||'all'}</button><button data-focus-region="content" data-focus-row="1" data-focus-col="1" data-focus-key="log-attempt" onClick={()=>setAttempt(value=>value===''?String(detail.job.attempt):'')}>Attempt: {attempt||'all'}</button></div>{logs.length===0?<p>No logs match these filters.</p>:logs.map((log,index)=>{const open=expanded===log.id;return <button type="button" aria-expanded={open} data-focus-region="content" data-focus-row={2+index} data-focus-col="0" data-focus-key={`job-log-${log.id}`} class={`job-log ${log.level} ${open?'expanded':''}`} onClick={()=>setExpanded(value=>value===log.id?null:log.id)}><span class="job-log-heading"><strong>{log.phase} · {log.level}</strong><i>{open?'Hide details':'Show details'}</i></span><span>{new Date(log.createdAt).toLocaleString()} · attempt {log.attempt}</span><small>{log.message}</small>{open&&<div class="job-log-expanded"><dl><dt>Job</dt><dd>{log.jobId}</dd><dt>Log entry</dt><dd>{log.id}</dd><dt>Attempt</dt><dd>{log.attempt}</dd></dl>{log.context&&Object.keys(log.context).length>0?<pre>{JSON.stringify(log.context,null,2)}</pre>:<p>No structured context was recorded.</p>}</div>}</button>})}{detail.next&&<button data-focus-region="content" data-focus-row={3+logs.length} data-focus-col="0" data-focus-key="job-logs-older" onClick={()=>void onOlder()}>Load older logs</button>}</section>
}

function TVEvents({api}:{api:API}){const[message,setMessage]=useState('');async function run(mode:'latest'|'rebuild'){try{const job=await api.syncCatalog(mode);setMessage(`${job.label} queued. Follow it on Jobs.`)}catch(error){setMessage((error as Error).message)}}return <section class="tv-settings"><h2>Server events</h2><p>Run the same safe catalog actions available in browser Settings.</p><button data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="event-latest" class="primary" onClick={()=>void run('latest')}>Fetch latest data</button><button data-focus-region="content" data-focus-row="2" data-focus-col="0" data-focus-key="event-rebuild" onClick={()=>void run('rebuild')}>Rebuild catalog cache</button><p aria-live="polite">{message}</p></section>}

function TVSettings({api,onChangeServer,onForgetServer}:{api:API;onChangeServer:()=>void;onForgetServer:()=>void}){
  const[value,setValue]=useState<Record<string,unknown>|null>(null);const[message,setMessage]=useState('Loading settings…');
  useEffect(()=>{api.call<Record<string,unknown>>('/settings').then(settings=>{setValue(settings);setMessage('')}).catch(error=>setMessage(error.message))},[]);
  async function save(){if(!value)return;const out={...value};Object.keys(out).filter(key=>key.endsWith('Configured')||key==='settingsPath').forEach(key=>delete out[key]);try{await api.call('/settings',{method:'PUT',body:JSON.stringify(out)});setMessage('Settings saved. Restart the server to apply worker-limit changes.')}catch(error){setMessage((error as Error).message)}}
  async function test(name:string){setMessage(`Testing ${name}…`);try{const result=await api.call<{message:string}>(`/dependencies/${name}/test`,{method:'POST'});setMessage(result.message)}catch(error){setMessage((error as Error).message)}}
  return <section class="tv-settings"><h2>Playback and connection</h2><p>API secrets and filesystem paths stay in browser Settings.</p>{value&&<div class="tv-safe-fields">
    <label>Preferred subtitle language<input data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="setting-subtitle-primary" value={String(value.preferredSubtitleLanguage||'')} onInput={event=>setValue({...value,preferredSubtitleLanguage:event.currentTarget.value})}/></label>
    <label>Fallback subtitle language<input data-focus-region="content" data-focus-row="2" data-focus-col="0" data-focus-key="setting-subtitle-fallback" value={String(value.fallbackSubtitleLanguage||'')} onInput={event=>setValue({...value,fallbackSubtitleLanguage:event.currentTarget.value})}/></label>
    <label>Watched threshold<input type="number" data-focus-region="content" data-focus-row="3" data-focus-col="0" data-focus-key="setting-watched" value={String(value.watchedThresholdPercent||90)} onInput={event=>setValue({...value,watchedThresholdPercent:Number(event.currentTarget.value)})}/></label>
    <label>Concurrent background jobs<input type="number" min="1" max="20" data-focus-region="content" data-focus-row="4" data-focus-col="0" data-focus-key="setting-workers" value={String(value.maxConcurrentJobs||10)} onInput={event=>setValue({...value,maxConcurrentJobs:Number(event.currentTarget.value)})}/></label>
    <label>Title refresh timeout (minutes)<input type="number" min="5" max="120" data-focus-region="content" data-focus-row="5" data-focus-col="0" data-focus-key="setting-title-timeout" value={String(value.titleRefreshTimeoutMinutes||30)} onInput={event=>setValue({...value,titleRefreshTimeoutMinutes:Number(event.currentTarget.value)})}/></label>
    <button class="primary" data-focus-region="content" data-focus-row="6" data-focus-col="0" data-focus-key="settings-save" onClick={()=>void save()}>Save preferences</button>
  </div>}<div class="tv-test-buttons">{['filelist','qbittorrent','storage','tmdb','subdl'].map((name,index)=><button data-focus-region="content" data-focus-row={7+index} data-focus-col="0" data-focus-key={`test-${name}`} onClick={()=>void test(name)}>Test {name}</button>)}</div><button data-focus-region="content" data-focus-row="13" data-focus-col="0" data-focus-key="change-server" onClick={onChangeServer}>Change server address</button><button data-focus-region="content" data-focus-row="14" data-focus-col="0" data-focus-key="forget-server" onClick={onForgetServer}>Forget this server</button><p aria-live="polite">{message}</p></section>
}

function TitleCard({api,title,row,col,focusRef,onOpen}:{api:API;title:CatalogTitle;row:number;col:number;focusRef?:{current:HTMLButtonElement|null};onOpen:()=>void}){
  return <button ref={focusRef} class="poster-card" data-focus-region="content" data-focus-row={row} data-focus-col={col} data-focus-key={`title-${title.id}`} onClick={onOpen}>{title.posterUrl?<img src={api.streamURL(title.posterUrl)} alt="" loading="lazy"/>:<div class="poster-fallback">{title.title.slice(0,1)}</div>}<div class="poster-copy"><strong>{title.title}</strong><span>{title.year||'—'} · {title.resolutions[0]||title.kind}{title.ratingVotes?` · ★ ${title.rating?.toFixed(1)}`:''}</span><small>{title.bestSeeders} seeders · {title.sourceCount} source{title.sourceCount===1?'':'s'}</small></div></button>;
}

function SourceButton({source,row,onPlay}:{source:CatalogSource;row:number;onPlay:(release:Release,fileIndex?:number)=>void}){return <button class="source-button" data-focus-region="content" data-focus-row={row} data-focus-col="0" data-focus-key={`source-${source.release.id}-${source.fileIndex??-1}`} onClick={()=>onPlay(source.release,source.fileIndex)}><span><strong>{source.parsed.resolution||'Source'}{source.parsed.hdr?` · ${source.parsed.hdr}`:''}</strong><small>{source.filePath||source.parsed.source||source.release.category} · {source.parsed.videoCodec||'codec unknown'}</small></span><span>{formatBytes(source.fileSizeBytes||source.release.sizeBytes)}<small>{source.release.seeders} seeders</small></span></button>}

function TitleDetail({api,detail,message,favorite,onClose,onFavorite,onPlay}:{api:API;detail:CatalogDetail;message:string;favorite:boolean;onClose:()=>void;onFavorite:(title:CatalogTitle,value:boolean)=>void;onPlay:(release:Release,fileIndex?:number)=>void}){
  const [season,setSeason]=useState(detail.seasons[0]?.number||0);
  const selected=detail.seasons.find(item=>item.number===season);
  const firstSource=detail.sources[0]||selected?.episodes[0]?.sources[0];
  useEffect(()=>{const timer=window.setTimeout(()=>focusElement(document.querySelector<HTMLElement>('[data-detail-initial]')),0);return()=>window.clearTimeout(timer);},[]);
  return <main class="detail-screen" style={detail.title.backdropUrl?{backgroundImage:`linear-gradient(90deg,#090d10 5%,rgba(9,13,16,.9) 55%,rgba(9,13,16,.4)),url(${api.streamURL(detail.title.backdropUrl)})`}:undefined}><button data-detail-initial data-focus-region="content" data-focus-row="0" data-focus-col="0" data-focus-key="detail-back" onClick={onClose}>← Back</button><div class="detail-copy"><span class="eyebrow">{detail.title.kind} · {detail.title.year||'Year unknown'}</span><h1>{detail.title.title}</h1><p>{detail.title.overview||'Choose the version that best matches your display and connection.'}</p><div class="detail-actions">{firstSource&&<button class="primary" data-focus-region="content" data-focus-row="1" data-focus-col="0" data-focus-key="detail-play" onClick={()=>onPlay(firstSource.release,firstSource.fileIndex)}>Play best source</button>}<button data-focus-region="content" data-focus-row="1" data-focus-col="1" data-focus-key="detail-favorite" onClick={()=>onFavorite(detail.title,!favorite)}>{favorite?'★ In favorites':'☆ Add to favorites'}</button></div></div>{message&&<p>{message}</p>}
    {detail.seasons.length>0&&<section class="season-browser"><h2>Seasons</h2><div class="season-tabs">{detail.seasons.map((item,index)=><button data-focus-region="content" data-focus-row="2" data-focus-col={index} data-focus-key={`season-${item.number}`} class={season===item.number?'active':''} onClick={()=>setSeason(item.number)}>Season {item.number}</button>)}</div>{selected?.episodes.map((episode,index)=><article class="episode-row"><div><b>{episode.number?`${episode.number}. `:''}{episode.title}</b><span>{episode.sourceCount} version{episode.sourceCount===1?'':'s'}</span></div>{episode.sources.map((source,sourceIndex)=><SourceButton source={source} row={3+index*20+sourceIndex} onPlay={onPlay}/>)}</article>)}</section>}
    {detail.seasons.length===0&&<section class="source-list"><h2>Available versions</h2>{detail.sources.map((source,index)=><SourceButton source={source} row={2+index} onPlay={onPlay}/>)}</section>}
  </main>;
}

function App() {
  const [server, setServer] = useState(localStorage.getItem(STORAGE) || '');
  const [draft, setDraft] = useState(server || 'http://server.lan:8097');
  const [api, setAPI] = useState<API | null>(null);
  const [titles, setTitles] = useState<CatalogTitle[]>([]);
  const [household, setHousehold] = useState<HouseholdState>(emptyState);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState('');
  const [player, setPlayer] = useState<{download: Download; resumeMs: number} | null>(null);
  const catalogFocus = useRef<string | null>(null);
  const loadState = async (client = api) => {if (client) try {setHousehold(await client.state());} catch (error) {setStatus((error as Error).message);}};
  async function connect(url = draft) {setStatus('Connecting…'); try {const client = new API(url); const info = await client.info(); const titlePage=await client.titles({pageSize:12,sort:'newest'});const [downloadPage,jobPage]=await Promise.all([client.downloads().catch(()=>({items:[],nextCursor:null,total:0})),client.jobs({pageSize:24}).catch(()=>({items:[],nextCursor:null,total:0}))]);localStorage.setItem(STORAGE,url.replace(/\/$/,''));setServer(url);setAPI(client);setStatus(`${info.name} ${info.version}`);setTitles(titlePage.items);void client.ensureMetadata(titlePage.items.map(item=>item.id)).catch(()=>{});setDownloads(downloadPage.items);setJobs(jobPage.items);await loadState(client);} catch (error) {setStatus((error as Error).message);}}
  async function play(release: Release, fileIndex = -1, resumeMs = 0) {if (!api) return; setStatus('Preparing source…'); try {const download = await api.prepare(release.id, fileIndex); if (!resumeMs) resumeMs = await api.playback(download.id).then(value => value.watched ? 0 : value.positionMs).catch(() => 0); setPlayer({download, resumeMs});} catch (error) {setStatus((error as Error).message);}}
  async function favorite(title: CatalogTitle, value: boolean) {if (!api) return; try {await api.titleFavorite(title.id, value); await loadState();} catch (error) {setStatus((error as Error).message);}}
  async function manageDownload(download:Download,action:string,deleteFiles=false){if(!api)return;try{await api.call(`/downloads/${encodeURIComponent(download.id)}/${action}?deleteFiles=${deleteFiles}`,{method:'POST'});setDownloads((await api.downloads()).items);}catch(error){setStatus((error as Error).message);}}
  useEffect(() => {['MediaPlayPause','MediaPlay','MediaPause','MediaStop','MediaRewind','MediaFastForward','MediaTrackPrevious','MediaTrackNext'].forEach(key => {try {window.tizen?.tvinputdevice?.registerKey(key);} catch {}}); if (server) void connect(server);}, []);
  useEffect(()=>{if(!api)return;let stream:EventSource|null=null;let timer=0;let stopped=false;let failures=0;const eventPayload=(event:MessageEvent)=>{const envelope=JSON.parse(event.data);return typeof envelope.payload==='string'?JSON.parse(envelope.payload):envelope.payload};const metadata=(event:MessageEvent)=>{try{const payload=eventPayload(event);const title=payload.title as CatalogTitle|undefined;if(!title?.id)return;setTitles(current=>current.some(item=>item.id===title.id)?current.map(item=>item.id===title.id?title:item):current)}catch(error){void api.diagnostic('warn','Could not process metadata event',{error:String(error)}).catch(()=>{})}};const searchCompleted=(event:MessageEvent)=>{try{const payload=eventPayload(event);window.dispatchEvent(new CustomEvent('catalog-search-completed',{detail:payload}));setStatus(`Search for ${payload.query||'title'} completed.`)}catch(error){void api.diagnostic('warn','Could not process search event',{error:String(error)}).catch(()=>{})}};const open=()=>{if(stopped)return;stream?.close();stream=new EventSource(`${api.base}/api/v1/events`);stream.onopen=()=>{failures=0;setStatus('Server connected')};stream.addEventListener('catalog.updated',()=>setStatus('Catalog updates available; use Refresh when ready.'));stream.addEventListener('catalog.search.completed',searchCompleted as EventListener);stream.addEventListener('metadata.updated',metadata as EventListener);stream.addEventListener('job.updated',()=>setStatus('A background job was updated.'));stream.onerror=()=>{stream?.close();if(stopped)return;failures++;const delay=Math.min(30_000,1000*Math.pow(2,Math.min(5,failures-1)));setStatus(`Server connection lost. Reconnecting in ${Math.ceil(delay/1000)}s…`);void api.diagnostic('warn','TV event stream disconnected',{attempt:failures}).catch(()=>{});window.clearTimeout(timer);timer=window.setTimeout(open,delay);};};open();return()=>{stopped=true;window.clearTimeout(timer);stream?.close()}},[api]);
  if (player && api) return <Player api={api} download={player.download} resumeMs={player.resumeMs} onStateChanged={() => loadState()} onClose={() => setPlayer(null)}/>;
  if (!api) return <Setup draft={draft} server={server} status={status} onDraft={setDraft} onConnect={() => void connect()} onForget={() => {localStorage.removeItem(STORAGE); setServer(''); setDraft('');}}/>;
  return <Catalog api={api} status={status} titles={titles} household={household} downloads={downloads} jobs={jobs} restoreFocus={catalogFocus.current} onFocus={key => {catalogFocus.current = key;}} onRetry={() => void connect(server)} onChangeServer={() => setAPI(null)} onForgetServer={() => {localStorage.removeItem(STORAGE); setAPI(null); setServer(''); setDraft('');}} onPlay={play} onPlayDownload={download=>setPlayer({download,resumeMs:0})} onManageDownload={(download,action,deleteFiles)=>void manageDownload(download,action,deleteFiles)} onFavorite={favorite}/>;
}

try {
  const root = document.getElementById('app');
  if (!root) throw new Error('The application root element is missing.');
  render(<App/>, root);
  window.FileListBoot?.ready();
} catch (error) {
  window.FileListBoot?.fail(error);
  throw error;
}
