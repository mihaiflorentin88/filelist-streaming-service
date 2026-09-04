import { useState } from 'preact/hooks';
import { useServerState } from './lib/state';
import { DownloadsPage } from './pages/DownloadsPage';
import { JobsPage } from './pages/JobsPage';
import { ServerPage } from './pages/ServerPage';
import { SettingsPage } from './pages/SettingsPage';
import '@filelist/web/style.css';

// Task 10 appended Server and Settings: one View member, one sections
// entry, and one render line each.
type View = 'downloads' | 'jobs' | 'server' | 'settings';
const sections: { id: View; label: string }[] = [
  { id: 'server', label: 'Server' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const [view, setView] = useState<View>('server');
  const server = useServerState();
  return (
    <div class="shell">
      <nav class="shell-nav" aria-label="Sections">
        {sections.map(s => (
          <button key={s.id} class={view === s.id ? 'active' : ''} onClick={() => setView(s.id)}>
            <span class={`dot dot-${server.state}`} aria-hidden="true" />
            {s.label}
          </button>
        ))}
      </nav>
      <div class="shell-main">
        <header class="shell-header">
          <h1>FileList Streaming</h1>
          <span class={`pill pill-${server.state}`}>
            <span class={`dot dot-${server.state}`} aria-hidden="true" />
            {server.state === 'running' ? `Running${server.address ? ` · ${server.address}` : ''}`
              : server.state === 'failed' ? 'Failed' : server.state[0].toUpperCase() + server.state.slice(1)}
          </span>
        </header>
        <main>
          {view === 'downloads' && <DownloadsPage />}
          {view === 'jobs' && <JobsPage />}
          {view === 'server' && <ServerPage />}
          {view === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
