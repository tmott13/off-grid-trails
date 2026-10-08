import { Injectable } from '@angular/core';
import { LatLon, Pack } from './models';

const DB = 'off-grid-trails';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const r = fn(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

/** Everything that has to survive with no signal lives here, in the phone's IndexedDB. */
@Injectable({ providedIn: 'root' })
export class PackStore {
  savePack(pack: Pack) { return tx('packs', 'readwrite', s => s.put(pack)); }
  getPack(id: string) { return tx<Pack | undefined>('packs', 'readonly', s => s.get(id)); }
  listPacks() { return tx<Pack[]>('packs', 'readonly', s => s.getAll()); }
  deletePack(id: string) { return tx('packs', 'readwrite', s => s.delete(id)); }

  get<T>(key: string) { return tx<T | undefined>('kv', 'readonly', s => s.get(key)); }
  set(key: string, value: unknown) { return tx('kv', 'readwrite', s => s.put(value, key)); }

  getCar(packId: string) { return this.get<LatLon>(`car:${packId}`); }
  setCar(packId: string, p: LatLon | null) { return this.set(`car:${packId}`, p); }
  getCrumbs(packId: string) { return this.get<LatLon[]>(`crumbs:${packId}`); }
  setCrumbs(packId: string, c: LatLon[]) { return this.set(`crumbs:${packId}`, c); }
}
