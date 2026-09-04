import { render } from 'preact';
import { App } from './App';
import { setServerOrigin } from './lib/state';

// Task 6 wiring point: the supervisor's real address arrives in the
// 'server:state' event once the Wails runner exists; until then the desktop
// shares the standalone server's default loopback port. Configured exactly
// once, before any page mounts.
setServerOrigin('http://127.0.0.1:8097');

render(<App />, document.getElementById('app')!);
