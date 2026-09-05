import { describe, expect, it, vi } from 'vitest';
import { API, PortalSync, eventPayload, loadPortalSession, portalSessionKey, promotionScreenTimeMs, savePortalSession, updateApplyOutcome, type PortalSessionStorage, type PortalState, type UpdateStatus } from './index';

// Shared portal + self-update contracts: the DTO shapes must mirror the Go
// JSON tags exactly, the SSE envelope decodes both layers, the JWT store
// scopes to the server origin and clears expired sessions, and PortalSync
// keeps a stale SSE replay from overriding a fresher HTTP refetch.

const snapshotJSON = '{"accountsEnabled":true,"adsEnabled":false,"donor":true,"links":[{"id":7,"title":"Project","url":"https://example.invalid/p","description":"A tool"}]}';
const promotionJSON = '{"id":"p1","provider":"prov","title":"Hello","text":"Body","image":"https://img","screenTime":8}';
const sessionJSON = '{"token":"jwt","expires_at":"2100-01-01T00:00:00Z"}';
const userJSON = '{"id":3,"email":"a@b.c","display_name":"Ada","role":"member"}';
const statusJSON = '{"currentVersion":"1.2.3","available":true,"latest":"1.3.0","notes":"Fixes","releasedAt":"2026-09-01T00:00:00Z","releasesUrl":"https://releases","selfUpdate":true,"applying":false}';

const sorted = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();

describe('portal DTO tags', () => {
  it('mirror the Go JSON tags exactly', () => {
    expect(sorted(JSON.parse(snapshotJSON))).toEqual(['accountsEnabled', 'adsEnabled', 'donor', 'links']);
    expect(sorted((JSON.parse(snapshotJSON) as PortalState).links[0])).toEqual(['description', 'id', 'title', 'url']);
    expect(sorted(JSON.parse(statusJSON))).toEqual(['applying', 'available', 'currentVersion', 'latest', 'notes', 'releasedAt', 'releasesUrl', 'selfUpdate']);
    expect(sorted(JSON.parse(sessionJSON))).toEqual(['expires_at', 'token']);
    expect(sorted(JSON.parse(userJSON))).toEqual(['display_name', 'email', 'id', 'role']);
  });

  it('promotion rotation floors sub-second and invalid windows at one second', () => {
    expect(promotionScreenTimeMs(8)).toBe(8000);
    expect(promotionScreenTimeMs(1000)).toBe(1000);
    expect(promotionScreenTimeMs(1500)).toBe(1500);
    for (const bad of [0, -5, Number.NaN]) expect(promotionScreenTimeMs(bad)).toBe(1000);
  });
});

describe('eventPayload', () => {
  it('parses the envelope and the JSON payload string', () => {
    const parsed = eventPayload<{ titleId: string }>('{"id":12,"kind":"portal.state","payload":"{\\"donor\\":false}","createdAt":"2026-09-05T00:00:00Z"}');
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(12);
    expect(parsed!.kind).toBe('portal.state');
    expect(parsed!.payload).toEqual({ donor: false });
  });

  it('answers null for malformed frames instead of throwing', () => {
    expect(eventPayload('not json')).toBeNull();
    expect(eventPayload('{"kind":7,"payload":"{}"}')).toBeNull();
    expect(eventPayload('{"kind":"portal.state","payload":"broken"}')).toBeNull();
  });
});

function memoryStorage(): PortalSessionStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: key => void data.delete(key) };
}

describe('portal session store', () => {
  it('scopes the record to the configured server origin', () => {
    const storage = memoryStorage();
    savePortalSession(storage, 'http://a.test', { token: 'jwt-a', expires_at: '2100-01-01T00:00:00Z' });
    expect(loadPortalSession(storage, 'http://a.test')?.token).toBe('jwt-a');
    expect(loadPortalSession(storage, 'http://b.test')).toBeNull();
    expect(storage.data.has(portalSessionKey('http://a.test'))).toBe(true);
  });

  it('clears an expired record on sight instead of replaying the dead token', () => {
    const storage = memoryStorage();
    savePortalSession(storage, 'http://a.test', { token: 'jwt', expires_at: new Date(Date.now() - 60_000).toISOString() });
    expect(loadPortalSession(storage, 'http://a.test')).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('tolerates corrupt records and records without a parseable expiry', () => {
    const storage = memoryStorage();
    storage.data.set(portalSessionKey('http://a.test'), '{broken');
    expect(loadPortalSession(storage, 'http://a.test')).toBeNull();
    savePortalSession(storage, 'http://a.test', { token: 'jwt', expires_at: 'not-a-date' });
    expect(loadPortalSession(storage, 'http://a.test')?.token).toBe('jwt');
  });
});

describe('PortalSync', () => {
  const state: PortalState = { accountsEnabled: true, adsEnabled: true, donor: false, links: [] };
  const status: UpdateStatus = { currentVersion: '1.0.0', available: false, releasesUrl: 'https://releases', selfUpdate: true, applying: false };
  const io = (stateResult: Promise<PortalState>, statusResult: Promise<UpdateStatus>) => ({ loadState: () => stateResult, loadStatus: () => statusResult });
  const unusedRejection = Promise.reject(new Error('unused'));
  unusedRejection.catch(() => { });

  it('refetches both snapshots on recovery and notifies subscribers', async () => {
    const sync = new PortalSync(io(Promise.resolve(state), Promise.resolve(status)));
    const seen: number[] = [];
    sync.subscribe(() => seen.push(1));
    await sync.recover();
    expect(sync.state).toBe(state);
    expect(sync.status).toBe(status);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('applies known events, keeps failure text until the next status, and ignores unknown kinds', () => {
    const sync = new PortalSync(io(unusedRejection, unusedRejection));
    expect(sync.absorb({ id: 1, kind: 'portal.state', payload: state })).toBe(true);
    expect(sync.state).toBe(state);
    expect(sync.absorb({ id: 2, kind: 'updates.failed', payload: { message: 'apply failed' } })).toBe(true);
    expect(sync.failure).toBe('apply failed');
    expect(sync.absorb({ id: 3, kind: 'updates.status', payload: status })).toBe(true);
    expect(sync.failure).toBe('');
    expect(sync.absorb({ id: 4, kind: 'catalog.updated', payload: {} })).toBe(false);
  });

  it('drops events while the recovery refetch is in flight; the refetch wins', async () => {
    let resolveState!: (value: PortalState) => void;
    const slowState = new Promise<PortalState>(resolve => { resolveState = resolve });
    const sync = new PortalSync(io(slowState, Promise.resolve(status)));
    sync.absorb({ id: 5, kind: 'portal.state', payload: { ...state, donor: true } });
    const recovery = sync.recover();
    expect(sync.refreshing).toBe(true);
    expect(sync.absorb({ id: 6, kind: 'portal.state', payload: state })).toBe(false);
    resolveState(state);
    await recovery;
    expect(sync.state).toBe(state);
    expect(sync.refreshing).toBe(false);
  });

  it('never lets a replayed id at or below the recovery marker override the refetch', async () => {
    const sync = new PortalSync(io(Promise.resolve({ ...state, accountsEnabled: false }), Promise.resolve(status)));
    sync.absorb({ id: 9, kind: 'portal.state', payload: state });
    await sync.recover(9);
    expect(sync.state?.accountsEnabled).toBe(false);
    expect(sync.absorb({ id: 4, kind: 'portal.state', payload: state })).toBe(false);
    expect(sync.absorb({ id: 9, kind: 'updates.status', payload: { ...status, available: true } })).toBe(false);
    expect(sync.state?.accountsEnabled).toBe(false);
    expect(sync.absorb({ id: 10, kind: 'portal.state', payload: state })).toBe(true);
    expect(sync.state?.accountsEnabled).toBe(true);
  });

  it('disconnect records the last seen id as the stale marker for recovery', async () => {
    const sync = new PortalSync(io(Promise.resolve({ ...state, adsEnabled: false }), Promise.resolve(status)));
    sync.absorb({ id: 20, kind: 'portal.state', payload: state });
    sync.disconnect();
    expect(sync.connected).toBe(false);
    await sync.recover();
    expect(sync.absorb({ id: 20, kind: 'portal.state', payload: { ...state, donor: true } })).toBe(false);
    expect(sync.state?.donor).toBe(false);
  });
});

describe('updateApplyOutcome', () => {
  it('maps 409 manual-only and busy rejections and treats the rest as failed', () => {
    expect(updateApplyOutcome(409, 'updates: installation is manual-only: capability probe failed')).toBe('manual-only');
    expect(updateApplyOutcome(409, 'updates: an apply operation is already in progress')).toBe('busy');
    expect(updateApplyOutcome(502, 'upstream returned an unusable click destination')).toBe('failed');
    expect(updateApplyOutcome(undefined, 'network gone')).toBe('failed');
  });
});

describe('portal client methods', () => {
  it('call the mounted S8 routes with leading-slash paths and no double prefix', async () => {
    const api = new API('http://server.test');
    const seen: Array<{ path: string; init?: RequestInit }> = [];
    vi.spyOn(api, 'call').mockImplementation(async (path: string, init?: RequestInit) => { seen.push({ path, init }); return null as never });
    await api.portalState();
    await api.portalPromotions(3);
    await api.portalSession('a@b.c', 'pw');
    await api.portalSessionRegister('a@b.c', 'pw', 'Ada');
    await api.portalMe('jwt');
    await api.updatesCurrent();
    await api.updatesCheck();
    await api.updatesApply();
    expect(seen.map(entry => entry.path)).toEqual([
      '/portal/state',
      '/portal/promotions?count=3',
      '/portal/session',
      '/portal/session/register',
      '/portal/session/me',
      '/updates/current',
      '/updates/check',
      '/updates/apply',
    ]);
    expect([seen[2].init?.method, seen[3].init?.method, seen[6].init?.method, seen[7].init?.method]).toEqual(['POST', 'POST', 'POST', 'POST']);
    expect(JSON.parse(String(seen[2].init?.body))).toEqual({ email: 'a@b.c', password: 'pw' });
    expect(JSON.parse(String(seen[3].init?.body))).toEqual({ email: 'a@b.c', password: 'pw', displayName: 'Ada' });
    expect((seen[4].init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    expect(api.promotionClickURL('prov', 'p/1')).toBe('http://server.test/api/v1/portal/promotions/prov/p%2F1/click');
  });
});
