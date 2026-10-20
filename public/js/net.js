/**
 * Online-first data access with an offline fallback.
 *
 * Reads: always try the network first. A successful response is shown and
 * also saved on the device. Only when the request fails (no signal, or no
 * answer within READ_TIMEOUT_MS) is the saved copy shown instead.
 *
 * Writes: sent straight to the server while online. If a write cannot get
 * through, it goes into the outbox and the app switches to offline mode. The
 * outbox is replayed in order as soon as the connection is back — on the
 * browser's "online" event, when the app returns to the foreground, and on a
 * periodic probe while anything is waiting.
 *
 * Server rejections (4xx) are not connectivity problems: retrying would fail
 * forever and block everything queued behind them, so they move to the
 * "failed" store for the engineer to review instead.
 */

import { idb } from './idb.js';

const READ_TIMEOUT_MS = 8000;
const WRITE_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 90000;
const PROBE_INTERVAL_MS = 15000;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class NetworkError extends Error {}
class AuthError extends Error {}

/** mode: "online" | "offline" | "auth" (Access session expired). */
let state = { mode: navigator.onLine === false ? 'offline' : 'online', pending: 0, failed: 0, syncing: false };
const statusListeners = new Set();
const eventListeners = new Set();
let inflightSeq = null;
let flushing = null;

export function getStatus() { return state; }

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(state);
  return () => statusListeners.delete(fn);
}

/** Events: { type: "synced", item, result } | { type: "failed", item, error } | { type: "drained" } */
export function onSyncEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of statusListeners) fn(state);
}

function emit(event) {
  for (const fn of eventListeners) fn(event);
}

async function refreshCounts() {
  setState({ pending: await idb.count('outbox'), failed: await idb.count('failed') });
}

function markOnline() {
  const wasDown = state.mode !== 'online';
  setState({ mode: 'online' });
  if (wasDown && state.pending > 0) flush();
}

function markDown(err) {
  setState({ mode: err instanceof AuthError ? 'auth' : 'offline' });
}

async function send(method, path, body, contentType, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      method,
      body,
      headers: contentType ? { 'content-type': contentType } : {},
      credentials: 'same-origin',
      // An expired Access session answers with a redirect to the login page.
      // Following it would fail as a CORS error that looks like "offline";
      // stopping at it lets us tell the engineer to sign in again.
      redirect: 'manual',
      signal: ctrl.signal,
    });
  } catch {
    throw new NetworkError('No connection');
  } finally {
    clearTimeout(timer);
  }

  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new AuthError('Sign-in expired');
  // Gateway errors and throttling are transient: keep the write and retry later.
  if (res.status >= 500 || res.status === 408 || res.status === 429) throw new NetworkError(`Server unavailable (${res.status})`);

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (isJson && data.error) || res.statusText);
  return data;
}

/**
 * GET with network-first, device-copy fallback.
 * Resolves { data, fromCache, savedAt }. Throws if offline with no saved copy.
 */
export async function apiGet(path) {
  if (navigator.onLine !== false) {
    try {
      const data = await send('GET', path, undefined, undefined, READ_TIMEOUT_MS);
      await idb.put('cache', { path, data, savedAt: Date.now() });
      markOnline();
      return { data, fromCache: false, savedAt: Date.now() };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      markDown(err);
    }
  } else {
    markDown(new NetworkError('Browser reports offline'));
  }

  const hit = await idb.get('cache', path);
  if (!hit) throw new Error('You are offline and this screen has not been opened on this device yet.');
  return { data: hit.data, fromCache: true, savedAt: hit.savedAt };
}

/** Apply a local change to a saved response, so the offline copy stays current. */
export async function patchCache(path, fn) {
  const hit = await idb.get('cache', path);
  if (!hit) return;
  const next = fn(hit.data);
  await idb.put('cache', { ...hit, data: next ?? hit.data });
}

/**
 * Send a write now if we can; otherwise queue it. Resolves
 * { queued: false, result } when the server answered, or { queued: true }.
 * Throws ApiError if the server rejected it (bad input — not worth queuing).
 *
 * item: { method, path, body, contentType, kind, meta }
 *   body is a JSON string or a Blob (photos). meta is app data used to show
 *   queued changes on screen before they sync (ids, floorId, ...).
 */
export async function apiWrite(item) {
  const timeout = item.body instanceof Blob ? UPLOAD_TIMEOUT_MS : WRITE_TIMEOUT_MS;

  // Anything already queued must reach the server first, or a device could
  // arrive before the survey it belongs to. So with a backlog, join the queue.
  if (state.pending === 0 && state.mode === 'online' && navigator.onLine !== false) {
    try {
      const result = await send(item.method, item.path, item.body, item.contentType, timeout);
      markOnline();
      return { queued: false, result };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      markDown(err);
    }
  }

  await enqueue(item);
  flush();
  return { queued: true };
}

/**
 * Online-only request for admin setup (imports, branding, briefings). These
 * are not queued: an admin needs to know now whether an import worked, and
 * replaying a large import later from a phone's outbox would be a surprise.
 */
export async function apiDirect(method, path, body, contentType) {
  try {
    const result = await send(method, path, body, contentType, UPLOAD_TIMEOUT_MS);
    markOnline();
    return result;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    markDown(err);
    throw new Error(err instanceof AuthError
      ? 'Your sign-in has expired. Sign in again, then retry.'
      : 'This needs a connection. Try again once you are back online.');
  }
}

/** Repeated saves of the same record while offline collapse into one queued write. */
async function enqueue(item) {
  if (item.method === 'PUT' && !(item.body instanceof Blob)) {
    const queued = await idb.all('outbox');
    const same = queued.find(q => q.method === 'PUT' && q.path === item.path && q.seq !== inflightSeq);
    if (same) {
      await idb.put('outbox', { ...same, body: item.body, meta: item.meta, queuedAt: Date.now() });
      await refreshCounts();
      return;
    }
  }
  await idb.add('outbox', { ...item, queuedAt: Date.now() });
  await refreshCounts();
}

/** Replay the outbox in order. Single-flight: concurrent callers share one run. */
export function flush() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  await refreshCounts();
  if (state.pending === 0) return;
  setState({ syncing: true });
  try {
    for (;;) {
      const item = await idb.first('outbox');
      if (!item) break;
      inflightSeq = item.seq;
      try {
        const timeout = item.body instanceof Blob ? UPLOAD_TIMEOUT_MS : WRITE_TIMEOUT_MS;
        const result = await send(item.method, item.path, item.body, item.contentType, timeout);
        await idb.delete('outbox', item.seq);
        if (item.kind === 'room' && result && result.merged_into) {
          await remapRoom(item.meta.id, result.merged_into);
        }
        setState({ mode: 'online' });
        emit({ type: 'synced', item, result });
      } catch (err) {
        if (err instanceof ApiError) {
          await idb.delete('outbox', item.seq);
          await idb.add('failed', { ...item, error: err.message, status: err.status, failedAt: Date.now() });
          emit({ type: 'failed', item, error: err });
          continue;
        }
        markDown(err);
        break;
      } finally {
        inflightSeq = null;
        await refreshCounts();
      }
    }
  } finally {
    setState({ syncing: false });
    await refreshCounts();
    if (state.pending === 0 && state.mode === 'online') emit({ type: 'drained' });
  }
}

/**
 * The server folded a room added offline into an existing one with the same
 * number. Point any queued device writes at the surviving room.
 */
async function remapRoom(oldId, newId) {
  for (const q of await idb.all('outbox')) {
    if (q.kind !== 'device' || typeof q.body !== 'string') continue;
    const body = JSON.parse(q.body);
    if (body.room_id !== oldId) continue;
    body.room_id = newId;
    await idb.put('outbox', { ...q, body: JSON.stringify(body) });
  }
}

export async function pendingItems() { return idb.all('outbox'); }
export async function failedItems() { return idb.all('failed'); }
export async function discardFailed(seq) { await idb.delete('failed', seq); await refreshCounts(); }

/** Retry a rejected write (e.g. after the cause was fixed server-side). */
export async function retryFailed(seq) {
  const item = await idb.get('failed', seq);
  if (!item) return;
  const { error, status, failedAt, seq: _seq, ...rest } = item;
  await idb.delete('failed', seq);
  await enqueue(rest);
  flush();
}

/** Lightweight reachability check used while offline. */
async function probe() {
  try {
    await send('GET', '/api/me', undefined, undefined, READ_TIMEOUT_MS);
    markOnline();
    if (state.pending > 0) flush();
  } catch (err) {
    if (!(err instanceof ApiError)) markDown(err);
  }
}

export function startSync() {
  refreshCounts().then(() => { if (state.pending > 0) flush(); });

  window.addEventListener('online', () => probe());
  window.addEventListener('offline', () => markDown(new NetworkError('Browser reports offline')));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (state.mode !== 'online' || state.pending > 0)) probe();
  });
  // The "online" event is unreliable on mobile (it fires on Wi-Fi association,
  // not on real reachability, and sometimes not at all), so probe as well.
  setInterval(() => {
    if (state.mode === 'auth') return; // needs the engineer to sign in; probing will not fix it
    if (state.mode !== 'online' || state.pending > 0) probe();
  }, PROBE_INTERVAL_MS);
}
