import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalHouseholdItems,formatBytes,logicalPlaybackPosition,orderDownloadIDs,preferredAudioTrack,reconcileDownloads,resumeActionLabel,resumeForTitle,resumeSummary,seasonPackActionLabel} from '../src/index.ts';

test('formatBytes uses readable decimal units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.match(formatBytes(1_000), /^1(?:[.,]0)? KB$/);
  assert.match(formatBytes(15_200_000_000), /^15[.,]2 GB$/);
  assert.match(formatBytes(1_000_000_000_000), /^1(?:[.,]0)? TB$/);
});

const download=(id,progress=0,createdAt='2026-01-01T00:00:00Z')=>({id,releaseId:id,engineId:`qb:${id}`,fileIndex:0,filePath:`${id}.mkv`,mimeType:'video/x-matroska',sizeBytes:100,state:'downloading',progress,playbackMode:progress>=1?'local':'progressive',downloadedBytes:progress*100,speedBytesPerSecond:10,etaSeconds:1,peers:1,seeds:1,leased:false,createdAt,updatedAt:createdAt,streamUrl:`/downloads/${id}/stream`});

test('download reconciliation patches rows without reordering existing downloads',()=>{
  const first=download('first',0.1,'2026-01-02T00:00:00Z');
  const second=download('second',0.2);
  const result=reconcileDownloads([first,second],[download('second',0.8),download('first',0.6,'2026-01-02T00:00:00Z')]);
  assert.deepEqual(result.map(item=>item.id),['first','second']);
  assert.equal(result[0].progress,0.6);
  assert.equal(result[1].progress,0.8);
});

test('download reconciliation prepends genuinely new rows and reuses unchanged objects',()=>{
  const first=download('first',0.1);
  const result=reconcileDownloads([first],[download('new',0,'2026-01-03T00:00:00Z'),download('first',0.1)]);
  assert.deepEqual(result.map(item=>item.id),['new','first']);
  assert.equal(result[1],first);
  assert.deepEqual(orderDownloadIDs(result,'recent'),['new','first']);
});

test('preferredAudioTrack keeps a matching saved stream then falls back by language',()=>{
  const tracks=[{streamIndex:1,language:'eng',default:true},{streamIndex:3,language:'ron'}];
  assert.equal(preferredAudioTrack(tracks,{audioLanguage:'ro',audioTrackIndex:3})?.streamIndex,3);
  assert.equal(preferredAudioTrack(tracks,{audioLanguage:'ro',audioTrackIndex:1})?.streamIndex,3);
  assert.equal(preferredAudioTrack(tracks,{audioLanguage:'de',audioTrackIndex:-1})?.streamIndex,1);
});

test('logicalPlaybackPosition adds compatibility offset and clamps to original duration',()=>{
  assert.equal(logicalPlaybackPosition(120_000,5.25,3_594_842),125_250);
  assert.equal(logicalPlaybackPosition(3_590_000,10,3_594_842),3_594_842);
});

const householdItem=(overrides={})=>({profileId:'household',sourceId:'source',releaseId:'release',fileIndex:2,filePath:'Silo.S01E03.mkv',positionMs:1_445_000,durationMs:3_600_000,watched:false,updatedAt:'2026-08-14T12:00:00Z',release:{id:'release',name:'Silo Season 1',category:'TV',sizeBytes:1,seeders:1,leechers:0,freeleech:false},favorite:false,titleId:'silo',seasonNumber:1,episodeNumber:3,...overrides});

test('resume selection matches canonical or embedded title identity and picks the newest unfinished episode',()=>{
  const older=householdItem({sourceId:'episode-2',episodeNumber:2,updatedAt:'2026-08-14T10:00:00Z'});
  const newest=householdItem({sourceId:'episode-3'});
  const watched=householdItem({sourceId:'episode-4',episodeNumber:4,watched:true,updatedAt:'2026-08-14T13:00:00Z'});
  const zero=householdItem({sourceId:'episode-5',episodeNumber:5,positionMs:0,updatedAt:'2026-08-14T14:00:00Z'});
  assert.equal(resumeForTitle([older,watched,zero,newest],'silo'),newest);
  const embedded=householdItem({titleId:undefined,catalog:{id:'embedded-title'}});
  assert.equal(resumeForTitle([embedded],'embedded-title'),embedded);
});

test('resume copy identifies a series episode and exact saved position',()=>{
  const item=householdItem();
  assert.equal(resumeActionLabel(item,'series'),'Resume S01E03');
  assert.equal(resumeActionLabel(item,'movie'),'Resume');
  assert.equal(resumeSummary(item,'series'),'S01E03 · Continue at 24:05 · Silo.S01E03.mkv');
});

test('canonical household cards keep the newest episode for each title',()=>{
  const older=householdItem({sourceId:'episode-2',episodeNumber:2,updatedAt:'2026-08-14T10:00:00Z'});
  const newest=householdItem({sourceId:'episode-3'});
  const movie=householdItem({titleId:'movie',sourceId:'movie-source',episodeNumber:undefined,seasonNumber:undefined});
  assert.deepEqual(canonicalHouseholdItems([older,movie,newest]),[newest,movie]);
});

test('season pack actions describe the exact release state',()=>{
  assert.equal(seasonPackActionLabel({downloadState:'none',watchState:'unwatched'}),'Download season');
  assert.equal(seasonPackActionLabel({downloadState:'downloading',watchState:'unwatched',progress:.42}),'Downloading 42%');
  assert.equal(seasonPackActionLabel({downloadState:'partial',watchState:'partial'}),'Continue season download');
  assert.equal(seasonPackActionLabel({downloadState:'downloaded',watchState:'watched'}),'Downloaded');
});
