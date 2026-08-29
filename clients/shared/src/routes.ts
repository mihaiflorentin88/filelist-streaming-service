// Client routes: every web screen owns a URL, so a refresh or a shared link
// lands on the same view. parsePath and buildPath are pure inverses over the
// adopted map; unknown paths parse to home, because the server renders the app
// for any path and the app decides what to show.

export type View = 'home' | 'search' | 'library' | 'continue' | 'favorites' | 'watched' | 'downloads' | 'library-categories' | 'tracker' | 'browse' | 'categories' | 'jobs' | 'events' | 'settings';
export interface Route { view: View; query?: string }

const viewPaths: Partial<Record<View, string>> = {
  search: '/search',
  library: '/library/dashboard',
  continue: '/library/continue',
  favorites: '/library/favorites',
  watched: '/library/watched',
  downloads: '/library/downloads',
  'library-categories': '/library/categories',
  tracker: '/tracker/dashboard',
  browse: '/tracker/browse',
  categories: '/tracker/categories',
  jobs: '/jobs',
  events: '/events',
  settings: '/settings',
};

const pathViews: Record<string, View> = { '/': 'home' };
for (const [view, path] of Object.entries(viewPaths)) pathViews[path] = view as View;


export function parsePath(pathname: string, search = ''): Route {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const view = pathViews[path] || 'home';
  return { view, query: view === 'search' ? new URLSearchParams(search).get('q') || '' : '' };
}

export function buildPath(route: Route): string {
  if (route.view === 'search' && route.query) return `/search?q=${encodeURIComponent(route.query)}`;
  return viewPaths[route.view] || '/';
}
