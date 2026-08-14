export interface Page<T>{items:T[];nextCursor:string|null;total:number;stale?:boolean}
export interface Release{id:string;name:string;category:string;sizeBytes:number;seeders:number;leechers:number;freeleech:boolean;imdbId?:string}
export type MediaKind='movie'|'series'
export interface ParsedRelease{title:string;sortTitle:string;kind:MediaKind;year?:number;seasonStart?:number;seasonEnd?:number;episodeStart?:number;episodeEnd?:number;episodeTitle?:string;resolution?:string;source?:string;videoCodec?:string;audio?:string;hdr?:string;edition?:string;releaseGroup?:string}
export type DownloadState='none'|'queued'|'downloading'|'partial'|'downloaded'|'error'
export type TransferState='idle'|'queued'|'active'|'paused'|'complete'|'error'
export type WatchState='unwatched'|'inProgress'|'partial'|'watched'
export interface MediaState{downloadState:DownloadState;transferState?:TransferState;watchState:WatchState;downloadId?:string;progress?:number;positionMs?:number;durationMs?:number}
export interface CatalogSource{release:Release;parsed:ParsedRelease;fileIndex?:number;filePath?:string;fileSizeBytes?:number;libraryState?:MediaState}
export interface CatalogTitle{id:string;title:string;originalTitle?:string;kind:MediaKind;year?:number;imdbId?:string;overview?:string;posterUrl?:string;backdropUrl?:string;rating?:number;ratingVotes?:number;ratingProvider?:string;categories:string[];resolutions:string[];sourceCount:number;seasonCount?:number;episodeCount?:number;bestSeeders:number;largestSizeBytes:number;newestUpload?:string;sources?:CatalogSource[];libraryState?:MediaState}
export interface CatalogEpisode{number:number;title:string;season:number;sourceCount:number;sources:CatalogSource[];libraryState?:MediaState}
export interface CatalogSeason{number:number;title:string;episodeCount:number;episodes:CatalogEpisode[];packSources?:CatalogSource[];libraryState?:MediaState}
export interface CatalogDetail{title:CatalogTitle;seasons:CatalogSeason[];sources:CatalogSource[]}
export interface CatalogFacets{categories:string[];kinds:string[];resolutions:string[];hdr:string[];sources:string[];codecs:string[]}
export interface Download{id:string;releaseId:string;titleId?:string;displayTitle?:string;releaseName?:string;category?:string;releaseSizeBytes?:number;trackerSeeders?:number;rating?:number;ratingVotes?:number;ratingProvider?:string;parsed?:ParsedRelease;engineId:string;fileIndex:number;filePath:string;mimeType:string;sizeBytes:number;state:string;progress:number;playbackMode:'local'|'progressive';downloadedBytes:number;speedBytesPerSecond:number;etaSeconds:number;peers:number;seeds:number;leased:boolean;error?:string;createdAt?:string;updatedAt?:string;streamUrl:string;browserStreamUrl?:string}
export interface MediaAudioTrack{streamIndex:number;language?:string;title?:string;codec?:string;channels?:number;default?:boolean}
export interface MediaInfo{durationMs:number;audioTracks:MediaAudioTrack[];probedAt?:string}
const downloadRenderFingerprint=(item:Download)=>[item.releaseId,item.titleId,item.displayTitle,item.releaseName,item.category,item.releaseSizeBytes,item.trackerSeeders,item.rating,item.ratingVotes,item.ratingProvider,item.engineId,item.fileIndex,item.filePath,item.mimeType,item.sizeBytes,item.state,item.progress,item.playbackMode,item.downloadedBytes,item.speedBytesPerSecond,item.etaSeconds,item.peers,item.seeds,item.leased,item.error,item.createdAt,item.updatedAt,item.streamUrl,item.parsed?.title,item.parsed?.seasonStart,item.parsed?.episodeStart,item.parsed?.resolution,item.parsed?.source,item.parsed?.videoCodec,item.parsed?.audio].join('\u0000')
export function reconcileDownloads(current:Download[],incoming:Download[]):Download[]{const unique:Download[]=[];const byID=new Map<string,Download>();for(const item of incoming){if(byID.has(item.id))continue;byID.set(item.id,item);unique.push(item)}if(current.length===0)return unique;const currentIDs=new Set(current.map(item=>item.id));const added=unique.filter(item=>!currentIDs.has(item.id));const retained:Download[]=[];for(const old of current){const next=byID.get(old.id);if(!next)continue;retained.push(downloadRenderFingerprint(old)===downloadRenderFingerprint(next)?old:{...old,...next})}return[...added,...retained]}
export type DownloadSort='recent'|'title'|'progress'|'size'|'speed'
export function orderDownloadIDs(items:Download[],sort:DownloadSort):string[]{return[...items].sort((a,b)=>{const difference=sort==='title'?(a.displayTitle||a.filePath).localeCompare(b.displayTitle||b.filePath):sort==='progress'?b.progress-a.progress:sort==='size'?b.sizeBytes-a.sizeBytes:sort==='speed'?b.speedBytesPerSecond-a.speedBytesPerSecond:Date.parse(b.createdAt||'')-Date.parse(a.createdAt||'');return difference||a.id.localeCompare(b.id)}).map(item=>item.id)}
export interface Job{id:string;kind:string;state:string;label:string;dedupeKey:string;progress:number;attempt:number;error?:string;retryable:boolean;nextAttemptAt?:string;createdAt:string;updatedAt:string}
export interface JobLog{id:number;jobId:string;attempt:number;level:string;phase:string;message:string;context?:Record<string,unknown>;createdAt:string}
export interface SearchResult extends Page<CatalogTitle>{job:Job}
export interface SettingsField{key:string;label:string;help:string;obtain?:string;tvVisible:boolean;sensitive:boolean;restartRequired:boolean;readOnly?:boolean}
export interface PlaybackState{profileId:string;sourceId:string;releaseId:string;fileIndex:number;filePath:string;positionMs:number;durationMs:number;watched:boolean;updatedAt:string}
export interface PlaybackPreferences{profileId?:string;sourceId?:string;audioLanguage:string;audioTrackIndex:number;subtitleLanguage:string;subtitleProvider?:string;subtitleCandidateId?:string;subtitleMode:'auto'|'off'|'selected';updatedAt?:string}
export function normalizedLanguage(value=''):string{const language=value.trim().toLocaleLowerCase();if(/^(en|eng)(-|$)/.test(language))return'en';if(/^(ro|ron|rum)(-|$)/.test(language))return'ro';return language.split('-')[0]}
export function preferredAudioTrack(tracks:MediaAudioTrack[],preferences:Pick<PlaybackPreferences,'audioLanguage'|'audioTrackIndex'>):MediaAudioTrack|undefined{const wanted=normalizedLanguage(preferences.audioLanguage);return tracks.find(track=>track.streamIndex===preferences.audioTrackIndex&&(!wanted||normalizedLanguage(track.language)===wanted))||tracks.find(track=>Boolean(wanted)&&normalizedLanguage(track.language)===wanted)||tracks.find(track=>normalizedLanguage(track.language)==='en')||tracks.find(track=>track.default)||tracks[0]}
export function logicalPlaybackPosition(streamOffsetMs:number,currentTimeSeconds:number,durationMs:number):number{const value=Math.max(0,streamOffsetMs+Math.round(Math.max(0,currentTimeSeconds)*1000));return durationMs>0?Math.min(value,durationMs):value}
export interface HouseholdItem extends PlaybackState{release:Release;catalog?:CatalogTitle;favorite:boolean;titleId?:string;seasonNumber?:number;episodeNumber?:number}
export interface HouseholdState{favorites:HouseholdItem[];continueWatching:HouseholdItem[];recent:HouseholdItem[];watched:HouseholdItem[]}
export function canonicalHouseholdItems(items:HouseholdItem[]):HouseholdItem[]{const selected=new Map<string,HouseholdItem>();const order:string[]=[];for(const item of items){const key=item.titleId||item.catalog?.id||item.sourceId||item.release.id;const current=selected.get(key);if(!current){selected.set(key,item);order.push(key);continue}const currentTime=Date.parse(current.updatedAt);const itemTime=Date.parse(item.updatedAt);if((Number.isFinite(itemTime)?itemTime:0)>(Number.isFinite(currentTime)?currentTime:0))selected.set(key,item)}return order.map(key=>selected.get(key) as HouseholdItem)}
export function resumeForTitle(items:HouseholdItem[],titleId:string):HouseholdItem|undefined{let selected:HouseholdItem|undefined;let selectedAt=-1;for(const item of items){if(item.watched||item.positionMs<=0)continue;if(item.titleId!==titleId&&item.catalog?.id!==titleId)continue;const updatedAt=Date.parse(item.updatedAt);const timestamp=Number.isFinite(updatedAt)?updatedAt:0;if(!selected||timestamp>selectedAt){selected=item;selectedAt=timestamp}}return selected}
function formatResumeTime(milliseconds:number):string{const total=Math.max(0,Math.floor(milliseconds/1000));const hours=Math.floor(total/3600);const minutes=Math.floor(total%3600/60);const seconds=total%60;return hours?`${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`:`${minutes}:${String(seconds).padStart(2,'0')}`}
export function resumeActionLabel(item:HouseholdItem,kind:MediaKind):string{if(kind!=='series')return'Resume';return item.seasonNumber&&item.episodeNumber?`Resume S${String(item.seasonNumber).padStart(2,'0')}E${String(item.episodeNumber).padStart(2,'0')}`:'Resume episode'}
export function resumeSummary(item:HouseholdItem,kind:MediaKind):string{const episode=kind==='series'&&item.seasonNumber&&item.episodeNumber?`S${String(item.seasonNumber).padStart(2,'0')}E${String(item.episodeNumber).padStart(2,'0')}`:'';return[episode,`Continue at ${formatResumeTime(item.positionMs)}`,item.filePath||item.release.name].filter(Boolean).join(' · ')}
export function seasonPackActionLabel(state?:MediaState):string{if(state?.transferState==='paused')return`Paused at ${Math.round((state.progress||0)*100)}%`;switch(state?.downloadState){case'downloaded':return'Downloaded';case'error':return'Retry season download';case'downloading':return`Downloading ${Math.round((state.progress||0)*100)}%`;case'queued':return'Queued';case'partial':return'Continue season download';default:return'Download season'}}
export interface LibraryCategory{name:string;count:number}
export interface SubtitleCandidate{id:string;provider:string;providerLabel?:string;language:string;title:string;fileName?:string;releaseName?:string;format?:string;uploader?:string;hearingImpaired?:boolean;description?:string;score:number;cached:boolean}
export interface SubtitleWarning{provider:string;message:string}
export interface SubtitlePage extends Page<SubtitleCandidate>{warnings:SubtitleWarning[]}
export interface SubtitleAsset{id:string;language:string;url:string;format:string;mimeType:string}
export function formatBytes(value:number):string{if(!Number.isFinite(value)||value<0)return '—';const units=['B','KB','MB','GB','TB'];let amount=value,index=0;while(amount>=1000&&index<units.length-1){amount/=1000;index++}const digits=index===0?0:1;return `${new Intl.NumberFormat(undefined,{maximumFractionDigits:digits}).format(amount)} ${units[index]}`}
export class API {
  base:string;
  constructor(base:string){this.base=base.replace(/\/$/,'')}
  async call<T>(path:string,init?:RequestInit):Promise<T>{const r=await fetch(`${this.base}/api/v1${path}`,{headers:{'Content-Type':'application/json'},...init});if(!r.ok){const p=await r.json().catch(()=>({detail:r.statusText}));throw new Error(p.detail||r.statusText)}if(r.status===204)return undefined as T;return r.json()}
  info(){return this.call<{name:string;instanceName?:string;version:string;apiVersion?:string;configured:boolean;capabilities?:string[]}>('/system/info')}
  latest(category=''){return this.call<Page<Release>>('/catalog/latest?category='+encodeURIComponent(category))}
  search(q:string){return this.call<Page<Release>>('/catalog/search?query='+encodeURIComponent(q))}
  searchTitles(query:string){return this.call<SearchResult>('/catalog/search',{method:'POST',body:JSON.stringify({query})})}
  refreshTitle(titleId:string,query=''){return this.call<Job>(`/catalog/titles/${encodeURIComponent(titleId)}/refresh`,{method:'POST',body:JSON.stringify({query})})}
  titles(query:Record<string,string|number|boolean|undefined>={}){const params=new URLSearchParams();for(const [key,value] of Object.entries(query)){if(value!==undefined&&value!=='')params.set(key,String(value))}return this.call<Page<CatalogTitle>>('/catalog/titles?'+params.toString())}
  title(id:string){return this.call<CatalogDetail>(`/catalog/titles/${encodeURIComponent(id)}`)}
  facets(){return this.call<CatalogFacets>('/catalog/facets')}
  prepare(id:string,fileIndex=-1){return this.call<Download>(`/releases/${encodeURIComponent(id)}/prepare`,{method:'POST',body:JSON.stringify({fileIndex})})}
  prepareSeason(id:string,season:number){return this.call<Page<Download>>(`/releases/${encodeURIComponent(id)}/prepare-season`,{method:'POST',body:JSON.stringify({season})})}
  downloads(){return this.call<Page<Download>>('/downloads')}
  mediaInfo(id:string){return this.call<MediaInfo>(`/downloads/${encodeURIComponent(id)}/media-info`)}
  nextEpisode(id:string){return this.call<Download|null>(`/downloads/${encodeURIComponent(id)}/next-episode`,{method:'POST'})}
  deleteDownload(id:string){return this.call<void>(`/downloads/${encodeURIComponent(id)}`,{method:'DELETE'})}
  jobs(query:Record<string,string|number|undefined>={}){const params=new URLSearchParams();for(const[key,value]of Object.entries(query)){if(value!==undefined&&value!=='')params.set(key,String(value))}return this.call<Page<Job>>('/jobs?'+params.toString())}
  job(id:string){return this.call<{job:Job;logs:Array<JobLog&{at:string}>}>(`/jobs/${encodeURIComponent(id)}`)}
  jobLogs(id:string,cursor=''){return this.call<Page<JobLog>>(`/jobs/${encodeURIComponent(id)}/logs?pageSize=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)}
  retryJob(id:string){return this.call<Job>(`/jobs/${encodeURIComponent(id)}/retry`,{method:'POST'})}
  syncCatalog(mode:'latest'|'rebuild'){return this.call<Job>('/catalog/sync',{method:'POST',body:JSON.stringify({mode})})}
  ensureMetadata(titleIds:string[]){return this.call<{queued:number}>('/metadata/ensure',{method:'POST',body:JSON.stringify({titleIds})})}
  diagnostic(level:string,message:string,context:Record<string,unknown>={}){return this.call<void>('/diagnostics/client',{method:'POST',body:JSON.stringify({level,message,context})})}
  subtitles(downloadId:string,language='',scope:'local'|'remote'|'all'='all'){return this.call<SubtitlePage>(`/downloads/${encodeURIComponent(downloadId)}/subtitles?language=${encodeURIComponent(language)}&scope=${scope}`)}
  prepareSubtitle(downloadId:string,provider:string,id:string,format:'sami'|'vtt'='sami'){return this.call<SubtitleAsset>(`/downloads/${encodeURIComponent(downloadId)}/subtitles/prepare`,{method:'POST',body:JSON.stringify({provider,id,format})})}
  state(){return this.call<HouseholdState>('/state')}
  library(section:'dashboard'|'continue-watching'|'favorites'|'watched'|'recent'){return section==='dashboard'?this.call<HouseholdState>('/library/dashboard'):this.call<Page<HouseholdItem>>(`/library/${section}`)}
  libraryCategories(category=''){return category?this.call<Page<HouseholdItem>>('/library/categories?category='+encodeURIComponent(category)):this.call<Page<LibraryCategory>>('/library/categories')}
  favorite(releaseId:string,value:boolean){return this.call<void>(`/favorites/${encodeURIComponent(releaseId)}`,{method:value?'PUT':'DELETE'})}
  titleFavorite(titleId:string,value:boolean){return this.call<void>(`/library/favorites/${encodeURIComponent(titleId)}`,{method:value?'PUT':'DELETE'})}
  playback(sourceId:string){return this.call<PlaybackState>(`/playback/${encodeURIComponent(sourceId)}`)}
  updatePlayback(sourceId:string,positionMs:number,durationMs:number){return this.call<PlaybackState>(`/playback/${encodeURIComponent(sourceId)}`,{method:'PUT',body:JSON.stringify({positionMs,durationMs})})}
  playbackPreferences(sourceId:string){return this.call<PlaybackPreferences>(`/playback/${encodeURIComponent(sourceId)}/preferences`)}
  updatePlaybackPreferences(sourceId:string,value:PlaybackPreferences){return this.call<PlaybackPreferences>(`/playback/${encodeURIComponent(sourceId)}/preferences`,{method:'PUT',body:JSON.stringify(value)})}
  setWatched(sourceId:string,watched:boolean){return this.call<PlaybackState>(`/playback/${encodeURIComponent(sourceId)}/watched`,{method:'PUT',body:JSON.stringify({watched})})}
  streamURL(path:string){return new URL(path,this.base).toString()}
}
