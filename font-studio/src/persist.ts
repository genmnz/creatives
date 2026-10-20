// Autosave the working font in IndexedDB so a refresh never loses work.
const DB = 'font-studio', STORE = 'session', KEY = 'current';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface SavedSession { bytes: Uint8Array; fileName: string; time: number; }

export const autosave = (bytes: Uint8Array, fileName: string) =>
  tx('readwrite', (s) => s.put({ bytes, fileName, time: Date.now() } satisfies SavedSession, KEY));
export const loadAutosave = () => tx<SavedSession | undefined>('readonly', (s) => s.get(KEY)).catch(() => undefined);
export const clearAutosave = () => tx('readwrite', (s) => s.delete(KEY)).catch(() => undefined);
