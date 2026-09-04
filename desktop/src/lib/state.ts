import { useEffect, useState } from 'preact/hooks';
import { Events } from '@wailsio/runtime';
import { configureSharedApi } from '@filelist/web/shared-api';

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

// StateEvent mirrors the Go gui.StateEvent the Wails runner (Task 6) emits
// on the 'server:state' topic.
export type StateEvent = { state: ServerState; error?: string; address?: string };

const IS_SERVER_STATE: Record<ServerState, true> = { stopped: true, starting: true, running: true, stopping: true, failed: true };

// The runner marshals the Go event payload to JSON over the Wails bridge,
// so it is validated once at this boundary before any view consumes it.
function isStateEvent(value: unknown): value is StateEvent {
  if (typeof value !== 'object' || value === null || !('state' in value)) return false;
  const { state } = value;
  return typeof state === 'string' && state in IS_SERVER_STATE;
}

// Boot-time wiring for the shared components' API origin. The loopback
// default stands in until Task 6's bootstrap replaces it with the
// supervisor's actual address carried by the state event.
export function setServerOrigin(origin: string): void { configureSharedApi(origin) }

let seeded: StateEvent = { state: 'stopped' };
// Called once at boot, before the first render, when the Go side hands over
// its current lifecycle state instead of waiting for the next emit.
export function seedServerState(event: StateEvent) { seeded = event }

export function useServerState(): StateEvent {
  const [state, setState] = useState<StateEvent>(seeded);
  useEffect(() => {
    const off = Events.On('server:state', event => {
      if (isStateEvent(event.data)) setState(event.data);
    });
    return off;
  }, []);
  return state;
}
