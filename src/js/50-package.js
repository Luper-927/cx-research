'use strict';
// cx.package/0.1: a single JSON file holding a whole workspace. Import validates everything BEFORE any write,
// then creates a NEW workspace in one transaction. It never overwrites or merges into existing data.
CX.pkg = (function () {
  const { CxError, canon, sha256, byteLength, validPath, parentOf, slug, saveTextFile } = CX.util;
  const store = CX.store;
  const HASH = /^sha256:[0-9a-f]{64}$/;
  const MAX_ENTRIES = 50000, MAX_BYTES = 60 * 1024 * 1024;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  async function build(ws) {
    const d = await ws.exportData();
    const body = { spec: 'cx.package/0.1', app: 'cx-alpha-' + CX.VERSION, created: new Date().toISOString(),
      workspace: { name: d.name, id: d.id, createdAt: d.createdAt, settings: d.settings }, entries: d.entries, blobs: d.blobs, snapshots: d.snapshots, journal: d.journal, head: d.head, root: d.root };
    body.packageHash = await sha256(canon(body));
    return body;
  }
  async function exportToFile(ws) {
    const pkg = await build(ws);
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = 'cx-' + slug(ws.name) + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.cxpkg.json';
    const text = JSON.stringify(pkg);
    const status = await saveTextFile(name, text);
    return { name, bytes: byteLength(text), status, files: pkg.entries.filter((e) => e.type === 'file').length };
  }
  async function checkEntries(list, blobs, where, errs) {
    const seen = new Set(), dirs = new Set(['/']);
    const sorted = [...list].sort((a, b) => (isObj(a) && isObj(b) ? String(a.path).length - String(b.path).length : 0));
    for (const e of sorted) {
      if (!isObj(e)) { errs.push(where + ': an entry is not an object.'); continue; }
      if (!validPath(e.path) || e.path === '/') { errs.push(where + ': invalid path ' + JSON.stringify(e.path).slice(0, 80) + '.'); continue; }
      if (seen.has(e.path)) { errs.push(where + ': duplicate path ' + e.path + '.'); continue; }
      seen.add(e.path);
      if (!dirs.has(parentOf(e.path))) errs.push(where + ': ' + e.path + ' has no parent folder in the package.');
      if (e.type === 'dir') { dirs.add(e.path); if (e.hash) errs.push(where + ': folder ' + e.path + ' must not have a hash.'); }
      else if (e.type === 'file') {
        if (!HASH.test(e.hash || '')) errs.push(where + ': file ' + e.path + ' has an invalid hash.');
        else if (!(e.hash in blobs)) errs.push(where + ': content for ' + e.path + ' is missing from the package.');
        if (!(Number.isInteger(e.size) && e.size >= 0)) errs.push(where + ': file ' + e.path + ' has an invalid size.');
      } else errs.push(where + ': ' + e.path + ' has unknown type ' + JSON.stringify(e.type) + '.');
      if (errs.length > 25) return;
    }
  }
  async function validate(obj) {
    const errs = [], warnings = [];
    const out = (extra) => ({ ok: errs.length === 0, errors: errs.slice(0, 25), warnings, summary: extra || null });
    if (!isObj(obj)) { errs.push('This file is not a CX package (expected a JSON object).'); return out(); }
    if (obj.spec !== 'cx.package/0.1') { errs.push('Unsupported or missing package “spec”. This build reads cx.package/0.1.'); return out(); }
    if (!isObj(obj.workspace) || typeof obj.workspace.name !== 'string' || !obj.workspace.name.trim() || obj.workspace.name.length > 80) errs.push('The workspace name is missing or invalid.');
    if (!Array.isArray(obj.entries) || !isObj(obj.blobs) || !Array.isArray(obj.snapshots) || !Array.isArray(obj.journal) || !isObj(obj.head)) { errs.push('The package is missing required sections (entries, blobs, snapshots, journal, head).'); return out(); }
    if (obj.entries.length > MAX_ENTRIES) { errs.push('The package has more than ' + MAX_ENTRIES + ' entries.'); return out(); }
    const { packageHash, ...rest } = obj;
    let calc; try { calc = await sha256(canon(rest)); } catch (e) { errs.push('The package contains values CX cannot verify.'); return out(); }
    if (calc !== packageHash) { errs.push('The package checksum does not match its contents. The file was edited or damaged.'); return out(); }
    let total = 0;
    for (const [h, c] of Object.entries(obj.blobs)) {
      if (!HASH.test(h) || typeof c !== 'string') { errs.push('A stored content block is malformed.'); break; }
      total += c.length;
      if ((await sha256(c)) !== h) { errs.push('Stored content fails its integrity check (' + h.slice(7, 19) + '…).'); break; }
      if (byteLength(c) > store.MAX_FILE) { errs.push('A stored file exceeds the 5 MiB limit.'); break; }
    }
    if (total > MAX_BYTES) errs.push('The package content is larger than this build accepts.');
    await checkEntries(obj.entries, obj.blobs, 'Workspace', errs);
    const ids = new Set();
    obj.snapshots.forEach((s, i) => {
      if (!isObj(s) || typeof s.id !== 'string' || !Array.isArray(s.entries) || typeof s.root !== 'string') errs.push('Snapshot ' + (i + 1) + ' is malformed.');
      else if (ids.has(s.id)) errs.push('Duplicate snapshot id ' + s.id + '.'); else ids.add(s.id);
    });
    if (errs.length === 0) {
      for (const s of obj.snapshots) {
        await checkEntries(s.entries, obj.blobs, 'Snapshot ' + s.id.slice(0, 10), errs);
        const root = await store.stateRootOf(new Map(s.entries.map((e) => [e.path, e])));
        if (root !== s.root) errs.push('Snapshot ' + s.id.slice(0, 10) + ' does not match its recorded state.');
        if (errs.length > 25) break;
      }
    }
    let jr = null;
    if (errs.length === 0) {
      const root = await store.stateRootOf(new Map(obj.entries.map((e) => [e.path, e])));
      if (obj.root !== root) errs.push('The recorded workspace state does not match the files in the package.');
      if (obj.journal.length === 0) errs.push('The package has no journal.');
      else {
        jr = await store.verifyRecords(obj.journal, root);
        jr.issues.forEach((i) => errs.push('Journal: ' + i));
        const last = obj.journal[obj.journal.length - 1];
        if (obj.head.hash !== last.hash || obj.head.seq !== last.seq) errs.push('The package head does not match its last journal record.');
      }
    }
    const files = obj.entries.filter((e) => e && e.type === 'file').length;
    return out({ name: obj.workspace && obj.workspace.name, files, dirs: obj.entries.length - files, snapshots: obj.snapshots.length, journal: obj.journal.length, bytes: total });
  }
  async function importPackage(obj) {
    const v = await validate(obj);
    if (!v.ok) throw new CxError('E_INVALID_PACKAGE', 'Import rejected. ' + v.errors[0], { errors: v.errors });
    const existing = (await store.listWorkspaces()).map((w) => w.name);
    let name = obj.workspace.name.trim();
    if (existing.includes(name)) name = (name + ' (imported)').slice(0, 80);
    return store.importWorkspace({
      name, createdAt: obj.workspace.createdAt, settings: obj.workspace.settings, entries: obj.entries, blobs: obj.blobs, snapshots: obj.snapshots, journalPrefix: obj.journal,
      events: [{ type: 'workspace.imported', subject: 'package', data: { source: 'cx.package/0.1', packageHash: obj.packageHash, originalId: obj.workspace.id || null, entries: obj.entries.length, journalRecords: obj.journal.length, snapshots: obj.snapshots.length } }],
    });
  }
  return { build, exportToFile, validate, importPackage };
})();
