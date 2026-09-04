import { render } from 'preact';
import { Events } from '@wailsio/runtime';
import { App } from './App';
import { ServerState } from './bindings/github.com/mihaiflorentin88/filelist-streaming-service/internal/gui/bindings';
import { isStateEvent, seedServerState, setServerOrigin, type StateEvent } from './lib/state';

// The supervisor listens on loopback (spec: Security), so an address like
// ":8097" or "127.0.0.1:8097" is the same origin; only the host part needs
// filling in.
function originOf(address: string): string {
  const host = address.startsWith(':') ? `127.0.0.1${address}` : address;
  return `http://${host}`;
}

// Boot wiring: the supervisor's real address arrives with the running
// state, so Downloads/Jobs poll the right origin instead of a hardcoded
// default port. seedServerState keeps late mounts current.
function apply(event: StateEvent): void {
  seedServerState(event);
  if (event.state === 'running' && event.address) setServerOrigin(originOf(event.address));
}

// Live events keep the seeded state and the origin current; they also reach
// every mounted component through its own subscription.
Events.On('server:state', event => {
  if (isStateEvent(event.data)) apply(event.data);
});

// The runner's boot emit fires before this webview loads, so a page that
// (re)loads while the server already runs would otherwise miss it: fetch
// the current state once, then render with the seed in place.
ServerState()
  .then(event => { if (isStateEvent(event)) apply(event) })
  .catch(() => { })
  .finally(() => { render(<App />, document.getElementById('app')!) });
