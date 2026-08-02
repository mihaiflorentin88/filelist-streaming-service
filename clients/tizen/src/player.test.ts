import {describe, expect, it} from 'vitest';
import {clampSeek, formatTime, isDownloadComplete, normalizeTrack, parseVTT, playerAction, preferredSubtitle, subtitleAt} from './player';

describe('player helpers', () => {
  it('formats player time', () => {expect(formatTime(65_400)).toBe('1:05'); expect(formatTime(3_665_000)).toBe('1:01:05');});
  it('clamps seeking inside the playable duration', () => {expect(clampSeek(-10, 100_000)).toBe(0); expect(clampSeek(100_000, 100_000)).toBe(99_000);});
  it('recognizes complete downloads', () => {expect(isDownloadComplete({progress:1} as any)).toBe(true); expect(isDownloadComplete({progress:.5,state:'downloading',downloadedBytes:5,sizeBytes:10} as any)).toBe(false);});
  it('maps remote media and navigation keys', () => {expect(playerAction('ArrowRight', 0)).toBe('right'); expect(playerAction('', 10252)).toBe('play-pause'); expect(playerAction('', 417)).toBe('fast-forward');});
  it('normalizes tracks and prefers Romanian then English subtitles', () => {
    const english = normalizeTrack({index:1,type:'TEXT',extra_info:JSON.stringify({language:'eng',codec:'srt'})});
    const romanian = normalizeTrack({index:2,type:'TEXT',extra_info:JSON.stringify({track_lang:'ron',fourCC:'srt'})});
    expect(english.label).toBe('English · srt');
    expect(preferredSubtitle([english, romanian])?.index).toBe(2);
    expect(preferredSubtitle([english])?.index).toBe(1);
  });
  it('parses and displays WebVTT cues at the requested playback time',()=>{const cues=parseVTT('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nSalut!\n\n00:03.500 --> 00:00:05.000\nHello');expect(cues).toHaveLength(2);expect(subtitleAt(cues,2_000)).toBe('Salut!');expect(subtitleAt(cues,4_000)).toBe('Hello');expect(subtitleAt(cues,500)).toBe('');});
});
