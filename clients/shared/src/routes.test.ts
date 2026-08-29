import { describe, expect, it } from 'vitest';
import { buildPath, parsePath } from '@filelist/shared';
import type { View } from '@filelist/shared';

// — Client routes: every web screen owns a URL, so a refresh or a shared link
// lands on the same view. buildPath and parsePath are pure inverses over the
// adopted map; anything unroutable parses to home, because the server renders
// the app for unknown paths and the app decides what to show.

const adopted: [View, string][] = [
  ['home', '/'],
  ['search', '/search'],
  ['library', '/library/dashboard'],
  ['continue', '/library/continue'],
  ['favorites', '/library/favorites'],
  ['watched', '/library/watched'],
  ['downloads', '/library/downloads'],
  ['library-categories', '/library/categories'],
  ['tracker', '/tracker/dashboard'],
  ['browse', '/tracker/browse'],
  ['categories', '/tracker/categories'],
  ['jobs', '/jobs'],
  ['events', '/events'],
  ['settings', '/settings'],
];

describe('Client routes', () => {
  it('round-trips every adopted route (build then parse)', () => {
    for (const [view, path] of adopted) {
      expect(buildPath({ view })).toBe(path);
      expect(parsePath(path, '')).toEqual({ view, query: '' });
    }
  });

  it('parses a search query and builds it back escaped', () => {
    expect(parsePath('/search', '?q=star+wars')).toEqual({ view: 'search', query: 'star wars' });
    expect(buildPath({ view: 'search', query: 'star wars' })).toBe('/search?q=star%20wars');
    expect(buildPath({ view: 'search', query: 'a&b=c' })).toBe('/search?q=a%26b%3Dc');
    expect(parsePath('/search', '?q=a%26b%3Dc').query).toBe('a&b=c');
  });

  it('round-trips a search through a full URL', () => {
    const url = buildPath({ view: 'search', query: 'interstellar 4K' });
    const [pathname, search] = url.split('?');
    expect(parsePath(pathname, search || '')).toEqual({ view: 'search', query: 'interstellar 4K' });
  });

  it('omits an empty search query from the URL', () => {
    expect(buildPath({ view: 'search', query: '' })).toBe('/search');
    expect(parsePath('/search', '?q=')).toEqual({ view: 'search', query: '' });
  });

  it('keeps the query out of views that do not read one', () => {
    expect(parsePath('/settings', '?q=x')).toEqual({ view: 'settings', query: '' });
  });

  it('falls back to home for unknown paths (the app decides)', () => {
    for (const path of ['/unknown', '/library/unknown', '/jobs/extra', '/library/dashboard/nested/path', '/LIBRARY/DOWNLOADS']) {
      expect(parsePath(path, '')).toEqual({ view: 'home', query: '' });
    }
    expect(buildPath({ view: 'gibberish' as View })).toBe('/');
  });

  it('tolerates a trailing slash on routed paths', () => {
    expect(parsePath('/library/downloads/', '')).toEqual({ view: 'downloads', query: '' });
    expect(parsePath('/', '')).toEqual({ view: 'home', query: '' });
  });
});
