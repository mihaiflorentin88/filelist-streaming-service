export interface Page<T>{items:T[];nextCursor:string|null;total:number;stale?:boolean}
export interface Release{id:string;name:string;category:string;sizeBytes:number;seeders:number;leechers:number;freeleech:boolean;imdbId?:string}
export type MediaKind='movie'|'series'
export interface ParsedRelease{title:string;sortTitle:string;kind:MediaKind;year?:number;seasonStart?:number;seasonEnd?:number;episodeStart?:number;episodeEnd?:number;episodeTitle?:string;resolution?:string;source?:string;videoCodec?:string;audio?:string;hdr?:string;edition?:string;releaseGroup?:string}
export interface CatalogSource{release:Release;parsed:ParsedRelease;fileIndex?:number;filePath?:string;fileSizeBytes?:number}
export interface CatalogTitle{id:string;title:string;originalTitle?:string;kind:MediaKind;year?:number;imdbId?:string;overview?:string;posterUrl?:string;backdropUrl?:string;rating?:number;ratingVotes?:number;ratingProvider?:string;categories:string[];resolutions:string[];sourceCount:number;seasonCount?:number;episodeCount?:number;bestSeeders:number;largestSizeBytes:number;newestUpload?:string;sources?:CatalogSource[]}
export interface CatalogEpisode{number:number;title:string;season:number;sourceCount:number;sources:CatalogSource[]}
export interface CatalogSeason{number:number;title:string;episodeCount:number;episodes:CatalogEpisode[]}
export interface CatalogDetail{title:CatalogTitle;seasons:CatalogSeason[];sources:CatalogSource[]}
export interface CatalogFacets{categories:string[];kinds:string[];resolutions:string[];hdr:string[];sources:string[];codecs:string[]}
export interface Download{id:string;releaseId:string;titleId?:string;displayTitle?:string;releaseName?:string;category?:string;releaseSizeBytes?:number;trackerSeeders?:number;rating?:number;ratingVotes?:number;ratingProvider?:string;parsed?:ParsedRelease;engineId:string;fileIndex:number;filePath:string;mimeType:string;sizeBytes:number;state:string;progress:number;downloadedBytes:number;speedBytesPerSecond:number;etaSeconds:number;peers:number;seeds:number;leased:boolean;error?:string;streamUrl:string}
export interface Job{id:string;kind:string;state:string;label:string;dedupeKey:string;progress:number;attempt:number;error?:string;retryable:boolean;nextAttemptAt?:string;createdAt:string;updatedAt:string}
export interface JobLog{id:number;jobId:string;attempt:number;level:string;phase:string;message:string;context?:Record<string,unknown>;createdAt:string}
export interface SearchResult extends Page<CatalogTitle>{job:Job}
export interface SettingsField{key:string;label:string;help:string;obtain?:string;tvVisible:boolean;sensitive:boolean;restartRequired:boolean}
export interface PlaybackState{profileId:string;sourceId:string;releaseId:string;fileIndex:number;filePath:string;positionMs:number;durationMs:number;watched:boolean;updatedAt:string}
export interface HouseholdItem extends PlaybackState{release:Release;catalog?:CatalogTitle;favorite:boolean}
export interface HouseholdState{favorites:HouseholdItem[];continueWatching:HouseholdItem[];recent:HouseholdItem[];watched:HouseholdItem[]}
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
  info(){return this.call<{name:string;version:string;configured:boolean}>('/system/info')}
  latest(category=''){return this.call<Page<Release>>('/catalog/latest?category='+encodeURIComponent(category))}
  search(q:string){return this.call<Page<Release>>('/catalog/search?query='+encodeURIComponent(q))}
  searchTitles(query:string){return this.call<SearchResult>('/catalog/search',{method:'POST',body:JSON.stringify({query})})}
  refreshTitle(titleId:string,query=''){return this.call<Job>(`/catalog/titles/${encodeURIComponent(titleId)}/refresh`,{method:'POST',body:JSON.stringify({query})})}
  titles(query:Record<string,string|number|boolean|undefined>={}){const params=new URLSearchParams();for(const [key,value] of Object.entries(query)){if(value!==undefined&&value!=='')params.set(key,String(value))}return this.call<Page<CatalogTitle>>('/catalog/titles?'+params.toString())}
  title(id:string){return this.call<CatalogDetail>(`/catalog/titles/${encodeURIComponent(id)}`)}
  facets(){return this.call<CatalogFacets>('/catalog/facets')}
  prepare(id:string,fileIndex=-1){return this.call<Download>(`/releases/${encodeURIComponent(id)}/prepare`,{method:'POST',body:JSON.stringify({fileIndex})})}
  downloads(){return this.call<Page<Download>>('/downloads')}
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
  setWatched(sourceId:string,watched:boolean){return this.call<PlaybackState>(`/playback/${encodeURIComponent(sourceId)}/watched`,{method:'PUT',body:JSON.stringify({watched})})}
  streamURL(path:string){return new URL(path,this.base).toString()}
}
