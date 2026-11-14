'use strict';
// Storage engine. All durable state lives in IndexedDB. Every change goes through commit():
//   1. stage an intent record, 2. build the change in memory, 3. apply entries + blobs + journal + workspace head
//   in ONE IndexedDB transaction, 4. read back and verify, 5. update the in-memory cache.
// Nothing outside IndexedDB takes part in a write, so no cross-storage atomicity is assumed.
CX.store = (function () {
  const { CxError, sha256, canon, randomId, byteLength, validPath, validName, parentOf, nameOf, joinPath } = CX.util;
  const idb = CX.idb, bus = CX.bus;
  const MAX_FILE = 5 * 1024 * 1024;
  const SETTINGS_DEFAULT = { theme: 'system', fontSize: 14, wordWrap: true };
  const caches = new Map();
  let recovery = { discarded: [], at: null };

  // ---- write serialisation (across tabs when Web Locks exist) ----
  let chain = Promise.resolve();
  const localQueue = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  let locksBroken = false;
  const withLock = (fn) => {
    if (!(navigator.locks && navigator.locks.request) || locksBroken) return localQueue(fn);
    let started = false;
    return navigator.locks.request('cx-write', () => { started = true; return localQueue(fn); })
      .catch((e) => { if (!started && e && e.name === 'SecurityError') { locksBroken = true; return localQueue(fn); } throw e; });   // opaque-origin frames refuse locks
  };

  // ---- other tabs: tell them when something changed so they reload from storage ----
  const tabId = randomId('tab_');
  const chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cx-alpha') : null;
  const tell = (m) => { if (chan) try { chan.postMessage({ ...m, tab: tabId }); } catch (_) { /* tab closing */ } };

  // ---- state root and journal records ----
  async function stateRootOf(entries) {
    const lines = [];
    for (const e of entries.values()) if (e.path !== '/') lines.push(e.path + '\t' + e.type + '\t' + (e.hash || ''));
    lines.sort();
    return sha256(lines.join('\n'));
  }
  async function buildRecord(prev, seq, ev, stateRoot) {
    const data = ev.data || {};
    const rec = { spec: 'cx.log/0.1', seq, ts: new Date().toISOString(), type: ev.type, subject: ev.subject == null ? null : ev.subject, dataHash: await sha256(canon(data)), data, stateRoot, prev };
    const { data: _d, ...rest } = rec;
    rec.hash = await sha256(canon(rest));
    return rec;
  }
  async function verifyRecords(recs, currentRoot) {
    const issues = [];
    let prev = CX.ZERO;
    for (let i = 0; i < recs.length; i++) {
      const { ws: _w, data, hash, ...rest } = recs[i];
      if (recs[i].seq !== i) issues.push('Sequence gap at position ' + i + ' (found ' + recs[i].seq + ').');
      if (recs[i].prev !== prev) issues.push('Chain link broken at record ' + recs[i].seq + '.');
      if (data !== undefined && (await sha256(canon(data))) !== recs[i].dataHash) issues.push('Record ' + recs[i].seq + ' data does not match its recorded hash.');
      if ((await sha256(canon(rest))) !== hash) issues.push('Record ' + recs[i].seq + ' hash does not match its content.');
      prev = hash;
    }
    const last = recs[recs.length - 1];
    if (last && currentRoot && last.stateRoot !== currentRoot) issues.push('Workspace contents do not match the last journal record. They were changed outside CX or are damaged.');
    return { valid: issues.length === 0, count: recs.length, issues, head: last ? last.hash : CX.ZERO };
  }

  // ---- loading ----
  async function load(id) {
    const res = await idb.tx(['workspaces', 'entries'], 'readonly', async (s) => {
      const rec = await idb.req(s.workspaces.get(id));
      if (!rec) return null;
      return { rec, ents: await idb.req(s.entries.index('ws').getAll(id)) };
    });
    if (!res) throw new CxError('E_NOT_FOUND', 'Workspace not found.');
    const w = { rec: res.rec, entries: new Map(res.ents.map((e) => [e.path, e])) };
    w.root = await stateRootOf(w.entries);
    caches.set(id, w);
    return w;
  }
  async function ensureFresh(id) {
    const db = await idb.get('workspaces', id);
    if (!db) { caches.delete(id); throw new CxError('E_NOT_FOUND', 'Workspace no longer exists.'); }
    const w = caches.get(id);
    if (!w || w.rec.headHash !== db.headHash || w.rec.headSeq !== db.headSeq || w.root !== db.stateRoot) return load(id);   // any disagreement: trust storage, not the cache
    w.rec = db;
    return w;
  }

  // ---- the commit pipeline ----
  async function commit(id, build, opts) {
    opts = opts || {};
    return withLock(async () => {
      bus.emit('store:busy');
      try { return await commitInner(id, build, opts); }
      catch (e) { const err = idb.wrap(e); bus.emit('store:error', err); throw err; }
      finally { bus.emit('store:idle'); }
    });
  }
  async function commitInner(id, build, opts) {
    const w = opts.create ? null : await ensureFresh(id);
    const plan = await build(w);
    if (plan.noop) return { records: [], root: w ? w.rec.stateRoot : null, result: plan.result };
    const entries = new Map(w ? w.entries : []);
    const dels = plan.dels || [], puts = plan.puts || [];
    for (const p of dels) entries.delete(p);
    for (const e of puts) entries.set(e.path, e);
    const rootBefore = w ? w.rec.stateRoot : null;
    const rootAfter = await stateRootOf(entries);
    if (plan.expectRoot && plan.expectRoot !== rootAfter) throw new CxError('E_VERIFY', 'The resulting contents do not match the expected state. Nothing was changed.');
    const prefix = plan.journalPrefix || [];
    let seq = prefix.length ? prefix[prefix.length - 1].seq + 1 : (w ? w.rec.headSeq + 1 : 0);
    let prev = prefix.length ? prefix[prefix.length - 1].hash : (w ? w.rec.headHash : CX.ZERO);
    const records = [];
    for (const ev of plan.events || []) {
      const rec = await buildRecord(prev, seq, ev, ev.before ? rootBefore : rootAfter);
      records.push(rec); prev = rec.hash; seq++;
    }
    if (!records.length && !prefix.length) throw new CxError('E_INTERNAL', 'A change must record at least one journal event.');
    const head = records.length ? records[records.length - 1] : prefix[prefix.length - 1];
    const now = Date.now();
    const intent = { id: randomId('int_'), ws: id, type: (plan.events && plan.events[0] && plan.events[0].type) || 'unknown', created: new Date(now).toISOString(), state: 'pending' };
    await idb.put('intents', intent);                                     // stage
    let next;
    try {
      next = await idb.tx(['workspaces', 'entries', 'blobs', 'snapshots', 'journal', 'intents'], 'readwrite', async (s) => {
        const cur = await idb.req(s.workspaces.get(id));
        if (opts.create) { if (cur) throw new CxError('E_EXISTS', 'Workspace id already exists.'); }
        else {
          if (!cur) throw new CxError('E_NOT_FOUND', 'Workspace no longer exists.');
          if (cur.headHash !== w.rec.headHash) throw new CxError('E_CONFLICT', 'This workspace changed in another tab. Reload and try again.');
        }
        for (const b of plan.blobs || []) s.blobs.put(b);
        for (const p of dels) s.entries.delete([id, p]);
        for (const e of puts) s.entries.put(e);
        for (const sn of plan.snapshotPuts || []) s.snapshots.put(sn);
        for (const sid of plan.snapshotDels || []) s.snapshots.delete([id, sid]);
        for (const r of prefix) s.journal.put({ ws: id, ...r });
        for (const r of records) s.journal.put({ ws: id, ...r });
        const base = opts.create ? plan.ws : { ...cur, ...(plan.wsPatch || {}) };
        const n = { ...base, headSeq: head.seq, headHash: head.hash, stateRoot: rootAfter, updatedAt: now };
        s.workspaces.put(n);
        s.intents.delete(intent.id);
        return n;
      });
    } catch (e) { try { await idb.del('intents', intent.id); } catch (_) { /* recovery handles leftovers */ } throw e; }
    const problems = await idb.tx(['workspaces', 'journal', 'entries', 'blobs'], 'readonly', async (s) => {   // verify
      const out = [];
      const rec = await idb.req(s.workspaces.get(id));
      if (!rec || rec.headHash !== head.hash) out.push('workspace head mismatch');
      const last = await idb.req(s.journal.get([id, head.seq]));
      if (!last || last.hash !== head.hash) out.push('journal head missing');
      for (const e of puts) {
        const got = await idb.req(s.entries.get([id, e.path]));
        if (!got || got.hash !== e.hash) out.push('entry mismatch ' + e.path);
        if (e.type === 'file' && (await idb.req(s.blobs.getKey(e.hash))) === undefined) out.push('content missing ' + e.path);
      }
      return out;
    });
    if (problems.length) { caches.delete(id); throw new CxError('E_VERIFY', 'Write verification failed: ' + problems.slice(0, 3).join('; ')); }
    caches.set(id, { rec: next, entries, root: rootAfter });
    bus.emit('ws:changed', { id, types: (plan.events || []).map((e) => e.type), paths: [...puts.map((e) => e.path), ...dels] });
    tell({ type: 'changed', id });
    return { records, root: rootAfter, result: plan.result };
  }

  // ---- entries ----
  async function makeEntry(ws, path, type, content, ctime, mtime, rev) {
    const base = { ws, path, type, name: nameOf(path), parent: parentOf(path), ctime, mtime, rev };
    if (type === 'dir') return { entry: { ...base, hash: null, size: 0 }, blob: null };
    if (typeof content !== 'string') throw new CxError('E_TYPE', 'File content must be text.');
    const size = byteLength(content);
    if (size > MAX_FILE) throw new CxError('E_TOO_LARGE', 'File is larger than the 5 MiB Alpha 0.1 limit.');
    const hash = await sha256(content);
    return { entry: { ...base, hash, size }, blob: { hash, content, size } };
  }
  function descendants(w, path) {
    const pre = path === '/' ? '/' : path + '/';
    return [...w.entries.values()].filter((e) => e.path !== '/' && (e.path === path || e.path.startsWith(pre)));
  }
  const checkPath = (p) => { if (!validPath(p) || p === '/') throw new CxError('E_PATH', 'Invalid path: ' + p); };
  const checkWsName = (n) => { n = String(n == null ? '' : n).trim(); if (!n || n.length > 80) throw new CxError('E_NAME', 'Workspace names must be 1 to 80 characters.'); return n; };

  function normSettings(s) {
    const o = { ...SETTINGS_DEFAULT };
    if (s && typeof s === 'object') {
      if (['system', 'dark', 'light'].includes(s.theme)) o.theme = s.theme;
      if (Number.isInteger(s.fontSize) && s.fontSize >= 10 && s.fontSize <= 28) o.fontSize = s.fontSize;
      if (typeof s.wordWrap === 'boolean') o.wordWrap = s.wordWrap;
    }
    return o;
  }

  class WS {
    constructor(id) { this.id = id; }
    get w() { const w = caches.get(this.id); if (!w) throw new CxError('E_STALE', 'Workspace is not loaded.'); return w; }
    get name() { return this.w.rec.name; }
    get settings() { return normSettings(this.w.rec.settings); }
    get ui() { return this.w.rec.ui || null; }
    get rec() { return this.w.rec; }
    stat(p) { return this.w.entries.get(p) || null; }
    exists(p) { return this.w.entries.has(p); }
    list(dir) {
      return [...this.w.entries.values()].filter((e) => e.path !== '/' && e.parent === dir)
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
    }
    all() { return [...this.w.entries.values()].filter((e) => e.path !== '/'); }
    async read(p) {
      const e = this.stat(p);
      if (!e || e.type !== 'file') throw new CxError('E_NOT_FOUND', 'File not found: ' + p);
      const b = await idb.get('blobs', e.hash);
      if (!b) throw new CxError('E_CORRUPT', 'The content of ' + p + ' is missing from storage. Restore a snapshot or import a backup.');
      if ((await sha256(b.content)) !== e.hash) throw new CxError('E_CORRUPT', 'The content of ' + p + ' fails its integrity check.');
      return b.content;
    }
    _create(path, type, content) {
      checkPath(path);
      return commit(this.id, async (w) => {
        if (w.entries.has(path)) throw new CxError('E_EXISTS', '“' + path + '” already exists.');
        const par = w.entries.get(parentOf(path));
        if (!par || par.type !== 'dir') throw new CxError('E_NO_PARENT', 'The parent folder does not exist.');
        const now = Date.now();
        const m = await makeEntry(this.id, path, type, content, now, now, 1);
        return { puts: [m.entry], blobs: m.blob ? [m.blob] : [], result: m.entry,
          events: [{ type: type === 'dir' ? 'folder.created' : 'file.created', subject: path, data: type === 'dir' ? { path } : { path, size: m.entry.size, hash: m.entry.hash } }] };
      }).then((r) => r.result);
    }
    createFile(path, content) { return this._create(path, 'file', content == null ? '' : content); }
    createDir(path) { return this._create(path, 'dir'); }
    writeFile(path, content, o) {
      checkPath(path);
      return commit(this.id, async (w) => {
        const cur = w.entries.get(path);
        if (!cur || cur.type !== 'file') throw new CxError('E_NOT_FOUND', 'File not found: ' + path);
        if (o && o.expectRev !== undefined && o.expectRev !== cur.rev) throw new CxError('E_CONFLICT', path + ' changed since you opened it.');
        const m = await makeEntry(this.id, path, 'file', content, cur.ctime, Date.now(), cur.rev + 1);
        if (m.entry.hash === cur.hash) return { noop: true, result: cur, events: [], puts: [] };
        return { puts: [m.entry], blobs: [m.blob], result: m.entry,
          events: [{ type: o && o.type ? o.type : 'file.updated', subject: path, data: { path, size: m.entry.size, hash: m.entry.hash, rev: m.entry.rev, ...(o && o.data ? o.data : {}) } }] };
      }).then((r) => r.result);
    }
    rename(from, to) {
      checkPath(from); checkPath(to);
      return commit(this.id, async (w) => {
        if (!w.entries.has(from)) throw new CxError('E_NOT_FOUND', 'Not found: ' + from);
        if (w.entries.has(to)) throw new CxError('E_EXISTS', '“' + to + '” already exists.');
        if (to.startsWith(from + '/')) throw new CxError('E_PATH', 'A folder cannot be moved into itself.');
        const par = w.entries.get(parentOf(to));
        if (!par || par.type !== 'dir') throw new CxError('E_NO_PARENT', 'The destination folder does not exist.');
        const subtree = descendants(w, from), now = Date.now();
        const puts = subtree.map((e) => {
          const np = to + e.path.slice(from.length);
          return { ...e, path: np, name: nameOf(np), parent: parentOf(np), rev: e.path === from ? e.rev + 1 : e.rev, mtime: e.path === from ? now : e.mtime };
        });
        return { puts, dels: subtree.map((e) => e.path), result: puts[0], events: [{ type: 'entry.renamed', subject: to, data: { from, to, entries: subtree.length } }] };
      }).then((r) => r.result);
    }
    remove(path, o) {
      checkPath(path);
      return commit(this.id, async (w) => {
        const e = w.entries.get(path);
        if (!e) throw new CxError('E_NOT_FOUND', 'Not found: ' + path);
        const sub = descendants(w, path);
        if (e.type === 'dir' && sub.length > 1 && !(o && o.recursive)) throw new CxError('E_NOT_EMPTY', 'The folder is not empty.');
        return { dels: sub.map((x) => x.path), result: sub.length,
          events: [{ type: e.type === 'dir' ? 'folder.deleted' : 'file.deleted', subject: path, data: { path, entries: sub.length } }] };
      }).then(async (r) => { gcBlobs().catch(() => {}); return r.result; });
    }
    async search(q, o) {
      o = { names: true, content: true, caseSensitive: false, limit: 200, ...(o || {}) };
      const needle = o.caseSensitive ? q : q.toLowerCase();
      const norm = (s
