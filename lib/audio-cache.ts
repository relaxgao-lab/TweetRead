/**
 * Two-tier TTS audio cache:
 *   Tier 1 — in-memory Map  (session-scoped, instant access)
 *   Tier 2 — IndexedDB       (cross-session, differentiated TTL by text length, 500-entry LRU)
 *
 * TTL strategy:
 *   single word  (≤20 chars)  → 90 days
 *   short phrase (21–100)     →  7 days
 *   long sentence (>100)      →  1 day
 *
 * All exports are safe to call on the server; they are no-ops when
 * `typeof window === 'undefined'`.
 */

const DB_NAME = 'tweetread-audio';
const STORE_NAME = 'tts-audio-cache';
const DB_VERSION = 1;
const MAX_ENTRIES = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

function getTTL(text: string): number {
  const len = text.trim().length;
  if (len <= 20)  return 90 * DAY_MS;
  if (len <= 100) return  7 * DAY_MS;
  return                  1 * DAY_MS;
}

// ── Tier 1: in-memory ────────────────────────────────────────────────────────
// Stored on `window` instead of module scope so that Next.js HMR re-evaluations
// do not clear the cache.

type WinWithCache = typeof globalThis & { __ttsMemCache?: Map<string, Blob> };

function getMemoryCache(): Map<string, Blob> {
  if (typeof window === 'undefined') return new Map();
  const w = window as WinWithCache;
  if (!w.__ttsMemCache) w.__ttsMemCache = new Map();
  return w.__ttsMemCache;
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

interface CacheRecord {
  key: string;
  blob: Blob;
  createdAt: number;
  accessedAt: number;
  size: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('by_accessed_at', 'accessedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function idbGet(db: IDBDatabase, key: string): Promise<CacheRecord | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as CacheRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, record: CacheRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbCount(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetOldestKeys(db: IDBDatabase, n: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('by_accessed_at');
    const keys: string[] = [];
    const req = index.openCursor(null, 'next');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || keys.length >= n) { resolve(keys); return; }
      keys.push((cursor.value as CacheRecord).key);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

function idbUpdateAccessedAt(db: IDBDatabase, key: string): void {
  idbGet(db, key).then((record) => {
    if (!record) return;
    idbPut(db, { ...record, accessedAt: Date.now() }).catch(() => {});
  }).catch(() => {});
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  const count = await idbCount(db);
  if (count <= MAX_ENTRIES) return;
  const toDelete = count - MAX_ENTRIES;
  const keys = await idbGetOldestKeys(db, toDelete);
  for (const key of keys) {
    await idbDelete(db, key);
    getMemoryCache().delete(key);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildCacheKey(
  text: string,
  voice: string = 'alloy',
  speed: number = 1.0,
): string {
  return `${text.trim().toLowerCase()}::${voice}::${speed.toFixed(1)}`;
}

export async function getCachedAudio(key: string, text: string): Promise<Blob | null> {
  if (typeof window === 'undefined') return null;

  // Tier 1
  if (getMemoryCache().has(key)) return getMemoryCache().get(key)!;

  // Tier 2
  try {
    const db = await openDB();
    const record = await idbGet(db, key);
    if (!record) return null;

    if (Date.now() - record.createdAt > getTTL(text)) {
      idbDelete(db, key).catch(() => {});
      return null;
    }

    getMemoryCache().set(key, record.blob);
    idbUpdateAccessedAt(db, key);
    return record.blob;
  } catch (err) {
    console.error('[TTS cache] IndexedDB read error:', err);
    return null;
  }
}

export async function setCachedAudio(key: string, blob: Blob): Promise<void> {
  if (typeof window === 'undefined') return;

  // Tier 1 (always)
  getMemoryCache().set(key, blob);

  // Tier 2
  try {
    const db = await openDB();
    const now = Date.now();
    await idbPut(db, { key, blob, createdAt: now, accessedAt: now, size: blob.size });
    await evictIfNeeded(db);
  } catch (err) {
    console.error('[TTS cache] IndexedDB write error — memory-only fallback:', err);
  }
}
