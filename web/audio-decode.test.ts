import { describe, expect, it } from 'vitest';
import { audioPlaybackRoute, byteOffsetForTime, windowByteBudget } from './audio-decode';

// Table tests for the pure routing seam: which codecs the browser plays through
// the video element (native) and which are handed to the client decoder.
describe('Audio playback route decision', () => {
  it('routes the natively decodable codecs to the element', () => {
    const cases: [string, 'native' | 'decode'][] = [
      ['aac', 'native'],
      ['mp3', 'native'],
      ['opus', 'native'],
      ['flac', 'native'],
      ['vorbis', 'native'],
    ];
    for (const [codec, expected] of cases) expect(audioPlaybackRoute(codec)).toBe(expected);
  });
  it('routes everything the browser cannot decode itself to the client decoder', () => {
    const cases: [string, 'native' | 'decode'][] = [
      ['ac3', 'decode'],
      ['eac3', 'decode'],
      ['dts', 'decode'],
      ['dca', 'decode'],
      ['truehd', 'decode'],
      ['alac', 'decode'],
      ['pcm_s16le', 'decode'],
      ['wmav2', 'decode'],
      ['notacodec', 'decode'],
      ['', 'decode'],
    ];
    for (const [codec, expected] of cases) expect(audioPlaybackRoute(codec)).toBe(expected);
  });
  it('normalizes case and surrounding whitespace before deciding', () => {
    expect(audioPlaybackRoute('AAC')).toBe('native');
    expect(audioPlaybackRoute(' Mp3 ')).toBe('native');
    expect(audioPlaybackRoute('EAC3')).toBe('decode');
  });
  it('answers missing codec strings with the decode route', () => {
    expect(audioPlaybackRoute(undefined)).toBe('decode');
    expect(audioPlaybackRoute(null)).toBe('decode');
  });
});

describe('Time to byte offset mapping', () => {
  it('maps seconds through the average byte rate', () => {
    expect(byteOffsetForTime(10, 1000, 1_000_000)).toBe(10_000);
    expect(byteOffsetForTime(0, 1000, 1_000_000)).toBe(0);
    expect(byteOffsetForTime(10_000, 1000, 1_000_000)).toBe(999_999);
    expect(byteOffsetForTime(-5, 1000, 1_000_000)).toBe(0);
    expect(byteOffsetForTime(10, 0, 1_000_000)).toBe(0);
    expect(byteOffsetForTime(10, 1000, 0)).toBe(0);
  });
});

describe('Decode window byte budget', () => {
  it('spans roughly thirty seconds of stream', () => {
    expect(windowByteBudget(100_000)).toBe(3_000_000);
  });
  it('clamps tiny and huge bitrates into a workable range', () => {
    expect(windowByteBudget(0)).toBe(1024 * 1024);
    expect(windowByteBudget(10)).toBe(1024 * 1024);
    expect(windowByteBudget(10_000_000)).toBe(16 * 1024 * 1024);
  });
});
