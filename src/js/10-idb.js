'use strict';
CX.idb = (function () {
  const { CxError } = CX.util;
  const DB = 'cx-alpha', VER = 1;
  let dbp = null;
  function wrap(e) {
    if (e instanceof CxError) return e;
    if (e && e.name === 'QuotaExceededError') return new CxError('E_QUOTA', 'Browser storage is full. Export your workspace, then free space.');
    return new CxError('E_IDB', 'Storage error: ' + (e && e.message ? e.message : String(e)));
  }
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new CxError('E_NO_IDB', 'IndexedDB is not available in this browser or mode (private browsing can disable it).'));
      let r; try { r = indexedDB.open(DB, VER); } catch (e) { return reject(wrap(e)); }
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('meta', { keyPath: 'key' });
        d.createObjectStore('workspaces', { keyPath: 'id' });
        d.createObjectStore('entries', { keyPath: ['ws', 'path'] }).createIndex('ws', 'ws');
        d.createObjectStore('blobs', { keyPath: 'hash' });
        d.createObjectStore('snapshots', { keyPath: ['ws', 'id'] }).createIndex('ws', 'ws');
        d.createObjectStore('journal', { keyPath: ['ws', 'seq'] });
        d.createObjectStore('intents', { keyPath: 'id' });
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); resolve(d); };
      r.onerror = () => reject(wrap(r.error));
      r.onblocked = () => reject(new CxError('E_IDB_BLOCKED', 'Storage upgrade is blocked by another CX tab. Close other tabs and reload.'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  // Runs `work` inside one transaction. Only await IndexedDB requests inside `work`.
  function tx(names, mode, work) {
    return open().then((d) => new Promise((resolve, reject) => {
      let t, result, failure;
      try { t = d.transaction(names, mode); } catch (e) { return reject(wrap(e)); }
      t.oncomplete = () => resolve(result);
      t.onabort = () => reject(wrap(failure || t.error));
      t.onerror = () => {};
      const stores = {};
      for (const n of [].concat(names)) stores[n] = t.objectStore(n);
      Promise.resolve().then(() => work(stores, t)).then((r) => { result = r; }, (e) => { failure = e; try { t.abort(); } catch (_) { /* already finished */ } });
    }));
  }
  const get = (store, key) => tx(store, 'readonly', (s) => req(s[store].get(key)));
  const getAll = (store) => tx(store, 'readonly', (s) => req(s[store].getAll()));
  const put = (store, val) => tx(store, 'readwrite', (s) => { s[store].put(val); });
  const del = (store, key) => tx(store, 'readwrite', (s) => { s[store].delete(key); });
  return { open, req, tx, get, getAll, put, del, wrap };
})();
