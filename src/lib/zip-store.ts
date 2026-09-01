// Small IndexedDB helper to keep generated ZIPs available for re-download.
const DB_NAME = "pixai";
const STORE = "zips";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export const saveZip = (id: string, blob: Blob) => tx("readwrite", (s) => s.put(blob, id));
export const getZip = (id: string) => tx<Blob | undefined>("readonly", (s) => s.get(id));
export const deleteZip = (id: string) => tx("readwrite", (s) => s.delete(id));
export const clearZips = () => tx("readwrite", (s) => s.clear());
