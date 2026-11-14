'use strict';
// Reads CX Web v0.9 data (localStorage key “cx” or a v0.9 backup file). Never writes to or deletes the original.
CX.legacy = (function () {
  const { sha256Hex, sha256, validPath, parentOf, byteLength } = CX.util;
  const GEN = '0'.repeat(64);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const readFile = (e) => (!e || typeof e !== 'object' ? '' : typeof e.c === 'string' ? e.c : typeof e.content === 'string' ? e.content : '');
  const looksLegacy = (d) => isObj(d) && isObj(d.fs) && isObj(d.fs['/']) && d.fs['/'].t === 'd';

  function detectLocal() {
    try {
      const raw = localStorage.getItem('cx');
      if (!raw) return null;
      const d = JSON.parse(raw);
      return looksLegacy(d) ? { raw, data: d } : null;
    } catch (e) { return null; }
  }
  const summarize = (d) => {
    const fs = d.fs, keys = Object.keys(fs).filter((k) => k !== '/');
    return { files: keys.filter((k) => fs[k] && fs[k].t === 'f').length, dirs: keys.filter((k) => fs[k] && fs[k].t === 'd').length, notes: Array.isArray(d.notes) ? d.notes.length : 0, journal: Array.isArray(d.cx_journal_v1) ? d.cx_journal_v1.length : 0 };
  };
  async function stateHash(d) {
    const fs = d.fs || {};
    return sha256Hex(JSON.stringify({ files: Object.keys(fs).sort().map((k) => [k, fs[k] && fs[k].t, readFile(fs[k])]), notes: d.notes || [], settings: d.settings || {} }));
  }
  // Same algorithm as CX Web v0.9 verifyJournal.
  async function verifyV1(d) {
    const j = d.cx_journal_v1;
    if (!Array.isArray(j)) return { present: false, valid: false, count: 0, issues: ['No hash-linked journal in this data.'], head: '' };
    const issues = []; let prev = GEN;
    for (let i = 0; i < j.length; i++) {
      const r = j[i];
      if (!isObj(r)) { issues.push('Invalid record at ' + i); prev = ''; continue; }
      if (r.n !== i) issues.push('Sequence mismatch at ' + i);
      if (r.previousHash !== prev) issues.push('Previous-hash mismatch at ' + i);
      if (typeof r.hash !== 'string' || !/^[a-f0-9]{64}$/.test(r.hash)) { issues.push('Invalid hash at ' + i); prev = String(r.hash || ''); continue; }
      const c = JSON.stringify({ n: r.n, timestamp: r.timestamp, action: r.action, details: r.details, state: r.state, previousHash: r.previousHash });
      if ((await sha256Hex(c)) !== r.hash) issues.push('Hash mismatch at ' + i);
      prev = r.hash;
    }
    const last = j[j.length - 1];
    if (last && last.state !== undefined && (await stateHash(d)) !== last.state) issues.push('Workspace data does not match the last journal record.');
    return { present: true, valid: issues.length === 0, count: j.length, issues, head: (last && last.hash) || '' };
  }
  async function toSpec(d, name) {
    const warnings = [], entries = [], dirs = new Set(['/']);
    const fs = d.fs;
    const addDir = (p) => { if (!dirs.has(p)) { addDir(parentOf(p)); dirs.add(p); entries.push({ path: p, type: 'dir' }); } };
    for (const p of Object.keys(fs).filter((k) => k !== '/').sort((a, b) => a.length - b.length)) {
      const e = fs[p];
      if (!validPath(p)) { warnings.push('Skipped invalid path: ' + p); continue; }
      if (!e || (e.t !== 'f' && e.t !== 'd')) { warnings.push('Skipped unknown entry: ' + p); continue; }
      if (!dirs.has(parentOf(p))) { warnings.push('Created missing folder for ' + p); addDir(parentOf(p)); }
      if (e.t === 'd') { addDir(p); continue; }
      const c = readFile(e);
      if (byteLength(c) > CX.store.MAX_FILE) { warnings.push('Skipped file over 5 MiB: ' + p); continue; }
      entries.push({ path: p, type: 'file', content: c });
    }
    const extra = [];
    if (Array.isArray(d.notes) && d.notes.length) {
      addDir('/Notes');
      d.notes.forEach((n, i) => { const t = typeof n === 'string' ? n : (n && n.text) || ''; extra.push({ path: '/Notes/note-' + (i + 1) + '.txt', type: 'file', content: t }); });
    }
    addDir('/.cx'); addDir('/.cx/legacy');
    if (Array.isArray(d.cx_journal_v1)) extra.push({ path: '/.cx/legacy/journal-v1.json', type: 'file', content: JSON.stringify(d.cx_journal_v1, null, 2) });
    if (Array.isArray(d.j)) extra.push({ path: '/.cx/legacy/legacy-journal.json', type: 'file', content: JSON.stringify(d.j, null, 2) });
    if (d.settings) extra.push({ path: '/.cx/legacy/settings.json', type: 'file', content: JSON.stringify(d.settings, null, 2) });
    entries.push(...extra);
    const v = await verifyV1(d), s = summarize(d);
    return { spec: { name, entries, blobs: {}, snapshots: [], journalPrefix: [],
      events: [{ type: 'workspace.created', subject: 'v0.9', data: { name, via: 'v0.9-migration' } },
        { type: 'log.bridged-from-v0.9', subject: 'v0.9', data: { legacyFormat: 'cx_journal_v1', legacyCount: v.count, legacyHead: v.head, legacyChainValid: v.valid, legacyIssues: v.issues.length, files: s.files, dirs: s.dirs, notes: s.notes, warnings: warnings.length, note: 'Alpha 0.1 starts a new chain. The v0.9 chain is preserved as /.cx/legacy/journal-v1.json.' } }] },
      warnings, verify: v, summary: s };
  }
  async function importData(d, name) {
    const r = await toSpec(d, name);
    const ws = await CX.store.importWorkspace(r.spec);
    return { ws, warnings: r.warnings, verify: r.verify, summary: r.summary };
  }
  async function markImported(raw, wsId) { await CX.idb.put('meta', { key: 'legacy:' + (await sha256(raw)).slice(7, 23), value: wsId }); }
  async function alreadyImported(raw) { const m = await CX.idb.get('meta', 'legacy:' + (await sha256(raw)).slice(7, 23)); return m ? m.value : null; }
  return { looksLegacy, detectLocal, summarize, verifyV1, importData, markImported, alreadyImported };
})();
