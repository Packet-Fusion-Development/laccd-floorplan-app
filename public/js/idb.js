/**
 * Minimal promise wrapper over IndexedDB — the on-device store behind
 * offline mode. Three object stores:
 *
 *   cache   last successful response per API path (keyPath "path")
 *   outbox  writes waiting to sync, replayed in insertion order ("seq")
 *   failed  writes the server rejected (4xx), kept so nothing vanishes silently
 *
 * IndexedDB rather than localStorage because the outbox holds photo Blobs,
 * and because localStorage is a few MB at most.
 */

const DB_NAME = 'pf-site-survey';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('failed')) db.createObjectStore('failed', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const idb = {
  async get(name, key) { return done((await store(name)).get(key)); },
  async all(name) { return done((await store(name)).getAll()); },
  async count(name) { return done((await store(name)).count()); },
  async put(name, value) { return done((await store(name, 'readwrite')).put(value)); },
  async add(name, value) { return done((await store(name, 'readwrite')).add(value)); },
  async delete(name, key) { return done((await store(name, 'readwrite')).delete(key)); },

  /** The lowest-keyed record — the next outbox item to send. */
  async first(name) {
    const req = (await store(name)).openCursor();
    const cursor = await done(req);
    return cursor ? cursor.value : null;
  },
};
