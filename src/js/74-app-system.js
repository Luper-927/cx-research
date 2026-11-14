'use strict';
// Workspaces, Monitor, Settings, Terminal.
(function () {
  const { h, icon, fmtBytes, fmtTime, shortHash, joinPath, resolvePath, parentOf, nameOf, validName } = CX.util;
  const ui = CX.ui, store = CX.store;
  const guard = (p) => Promise.resolve(p).catch(ui.fail);
  const MAX_IMPORT = 80 * 1024 * 1024;

  CX.apps.register({ id: 'workspaces', title: 'Workspaces', icon: 'grid', short: 'Spaces', create(ctx) {
    const ws = () => ctx.ws();
    const picker = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', 'aria-hidden': 'true', tabIndex: -1 });
    const banner = h('div'), list = h('div');
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary sm', onclick: () => guard(ctx.shell.createWorkspaceFlow().then(refresh)) }, icon('plus'), h('span', { text: 'New workspace' })),
      h('button', { class: 'btn sm', onclick: () => picker.click() }, icon('upload'), h('span', { text: 'Import' })),
      h('button', { class: 'btn sm', onclick: () => guard(exportCurrent()) }, icon('download'), h('span', { text: 'Export current' })), picker),
    h('div', { class: 'list pad' }, banner, h('div', { class: 'card' }, h('h3', { text: 'Moving from another copy of CX?' }), h('p', { class: 'muted', style: 'margin:0', text: 'Data does not follow you between web addresses. In the other copy open Workspaces, choose Export current, then choose Import here. The original is never changed.' })), list));
    picker.addEventListener('change', () => guard(importFile(picker.files[0])).finally(() => { picker.value = ''; }));
    async function exportCurrent() { const r = await CX.pkg.exportToFile(ws()); if (r.status === 'saved') ui.toast('Exported ' + r.files + ' file(s) to ' + r.name, 'ok'); }
    async function importFile(f) {
      if (!f) return;
      if (f.size > MAX_IMPORT) throw new CX.util.CxError('E_TOO_LARGE', 'That file is larger than the 80 MiB import limit.');
      let obj; try { obj = JSON.parse(await f.text()); } catch (e) { await ui.notice('Import rejected', 'The file is not valid JSON. Nothing was changed.', [e.message]); return; }
      if (obj && obj.spec === 'cx.package/0.1') {
        const v = await CX.pkg.validate(obj);
        if (!v.ok) { await ui.notice('Import rejected', 'This package failed validation. Nothing was changed.', v.errors); return; }
        const s = v.summary;
        if (!(await ui.confirm('Import “' + s.name + '”?', s.files + ' files, ' + s.dirs + ' folders, ' + s.snapshots + ' snapshots, ' + s.journal + ' journal records. It becomes a NEW workspace; nothing existing is changed.', { okLabel: 'Import' }))) return;
        const w = await CX.pkg.importPackage(obj); ui.toast('Imported “' + w.name + '”.', 'ok'); await refresh(); return;
      }
      if (CX.legacy.looksLegacy(obj)) { await importLegacy(obj, 'Imported v0.9 backup'); return; }
      await ui.notice('Import rejected', 'This file is not a CX package or a CX Web v0.9 backup. Nothing was changed.', []);
    }
    async function importLegacy(data, name, raw) {
      const sm = CX.legacy.summarize(data);
      if (!(await ui.confirm('Import v0.9 data?', sm.files + ' files, ' + sm.dirs + ' folders, ' + sm.notes + ' notes. They become a NEW workspace. The original v0.9 data is left untouched.', { okLabel: 'Import' }))) return;
      const r = await CX.legacy.importData(data, name);
      if (raw) await CX.legacy.markImported(raw, r.ws.id);
      await ui.notice('v0.9 data imported', r.verify.present ? (r.verify.valid ? 'The v0.9 journal chain verified (' + r.verify.count + ' records).' : 'The v0.9 journal chain did NOT verify. The data was still imported, and the old chain is kept in /.cx/legacy/.') : 'No v0.9 journal was present.', r.warnings);
      await refresh();
    }
    async function refresh() {
      const all = await store.listWorkspaces(); list.textContent = ''; banner.textContent = '';
      const lg = CX.legacy.detectLocal();
      if (lg && !(await CX.legacy.alreadyImported(lg.raw))) {
        const sm = CX.legacy.summarize(lg.data);
        banner.append(h('div', { class: 'card' }, h('h3', { text: 'CX Web v0.9 data found' }), h('p', { class: 'muted', style: 'margin:0 0 8px', text: sm.files + ' files, ' + sm.dirs + ' folders, ' + sm.notes + ' notes, ' + sm.journal + ' journal records. Import copies them into a new workspace. The original stays where it is.' }),
          h('button', { class: 'btn primary sm', onclick: () => guard(importLegacy(lg.data, 'Imported from v0.9', lg.raw)) }, 'Import v0.9 data')));
      }
      all.forEach((w) => {
        const cur = ws() && w.id === ws().id;
        list.append(h('div', { class: 'ws-item' + (cur ? ' current' : ''), dataset: { ws: w.id } },
          h('div', { style: 'min-width:0;flex:1' }, h('div', { style: 'font-weight:600;overflow-wrap:anywhere', text: w.name }), h('div', { class: 'muted mono', text: 'Created ' + fmtTime(w.createdAt) + ' · changed ' + fmtTime(w.updatedAt) + ' · ' + (w.headSeq + 1) + ' journal records' }), cur ? h('span', { class: 'badge ok', text: 'open' }) : null),
          h('div', { class: 'split' },
            cur ? null : h('button', { class: 'btn sm', onclick: () => guard(ctx.shell.switchWorkspace(w.id).then(refresh)), text: 'Open' }),
            h('button', { class: 'btn sm', onclick: () => guard(rename(w)), text: 'Rename' }),
            h('button', { class: 'btn sm danger', onclick: () => guard(del(w)), text: 'Delete' }))));
      });
    }
    async function rename(w) {
      const taken = (await store.listWorkspaces()).filter((x) => x.id !== w.id).map((x) => x.name.toLowerCase());
      const n = await ui.prompt('Rename workspace', 'Name', w.name, { okLabel: 'Rename', validate: (v) => (!v.trim() ? 'Enter a name.' : v.trim().length > 80 ? 'Use 80 characters or fewer.' : taken.includes(v.trim().toLowerCase()) ? 'That name is already used.' : '') });
      if (n === null || n.trim() === w.name) return;
      await (await store.open(w.id)).rename_(n.trim());
      if (ws() && ws().id === w.id) document.getElementById('ws-name').textContent = n.trim();
      await refresh();
    }
    async function del(w) {
      const ok = await ui.confirm('Delete “' + w.name + '”?', 'All its files, snapshots and journal are permanently deleted from this browser. Export it first if you may need it again.', { danger: true, okLabel: 'Delete workspace', typeToConfirm: w.name });
      if (!ok) return;
      await store.deleteWorkspace(w.id); ui.toast('Deleted “' + w.name + '”.', 'ok');
      await ctx.shell.afterDelete(w.id); if (ctx.shell.ws()) await refresh();
    }
    return { el, refresh: () => guard(refresh()) };
  } });

  CX.apps.register({ id: 'monitor', title: 'Monitor', icon: 'pulse', create(ctx) {
    const body = h('div', { class: 'pad' });
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar' },
      h('button', { class: 'btn sm', onclick: () => guard(refresh()), text: 'Refresh' }),
      h('button', { class: 'btn sm', onclick: () => guard(persist()), text: 'Request persistent storage' }),
      h('button', { class: 'btn sm', onclick: () => guard(reclaim()), text: 'Reclaim unused space' })), h('div', { class: 'list' }, body));
    async function persist() { if (!(navigator.storage && navigator.storage.persist)) throw new CX.util.CxError('E_UNSUPPORTED', 'This browser cannot request persistent storage.'); const g = await navigator.storage.persist(); ui.toast(g ? 'Persistent storage granted. The browser should not evict CX data automatically.' : 'The browser did not grant persistent storage. Keep exported backups.', g ? 'ok' : 'warn'); await refresh(); }
    async function reclaim() { const n = await store.gcBlobs(); ui.toast(n + ' unused stored file version(s) removed.', 'ok'); await refresh(); }
    const stat = (k, v) => h('div', { class: 'stat' }, h('span', { class: 'muted', text: k }), h('span', { class: 'v', text: String(v) }));
    async function refresh() {
      const s = await store.stats(), rec = store.recovery();
      const cap = (name, ok, note) => h('li', { class: ok ? 'info' : 'err' }, h('strong', { text: name }), ' ' + (ok ? 'available' : 'NOT available') + (note ? '. ' + note : ''));
      body.textContent = '';
      body.append(
        h('div', { class: 'grid-stats' }, stat('Used', fmtBytes(s.usage)), stat('Browser quota', fmtBytes(s.quota)), stat('Stored file versions', s.blobCount), stat('Their size', fmtBytes(s.blobBytes))),
        h('div', { class: 'card' }, h('h3', { text: 'Where your data lives' }), h('p', { class: 'muted', style: 'margin:0 0 6px', text: 'Web address: ' + location.origin + '. Browsers keep data separately for each web address, so another copy of CX at a different address has different workspaces. Move data between addresses with Export, then Import.' }),
          /\.github\.io$/.test(location.hostname) ? h('p', { class: 'muted', style: 'margin:0', text: 'This address is shared by every GitHub Pages site under the same GitHub user. Other pages there could read this storage. CX Alpha stores no keys or secrets. Use your own domain before that changes.' }) : null),
        h('div', { class: 'card' }, h('h3', { text: 'Storage' }), h('p', { class: 'muted', style: 'margin:0', text: 'Persistent storage: ' + (s.persisted == null ? 'unknown.' : s.persisted ? 'granted.' : 'not granted. The browser may clear this data under storage pressure, so export backups.') + ' Usage and quota are estimates reported by the browser for this whole site, not only CX.' })),
        h('div', { class: 'card' }, h('h3', { text: 'Workspaces' }), ...s.workspaces.map((w) => h('div', { class: 'mono', style: 'padding:4px 0;overflow-wrap:anywhere', text: w.name + ': ' + w.files + ' files, ' + w.dirs + ' folders, ' + fmtBytes(w.bytes) + ', ' + w.snapshots + ' snapshots, ' + w.journal + ' journal records' }))),
        h('div', { class: 'card' }, h('h3', { text: 'This device and browser' }),
          h('p', { class: 'muted mono', style: 'margin:0', text: 'CPU cores (logical): ' + (navigator.hardwareConcurrency || 'not reported') + ' · Memory (approx): ' + (navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'not reported') + ' · Online: ' + navigator.onLine })),
        h('div', { class: 'card' }, h('h3', { text: 'Recovery' }), h('p', { class: 'muted', style: 'margin:0', text: rec.discarded.length ? rec.discarded.length + ' interrupted change(s) were discarded at startup (' + rec.discarded.map((d) => d.type).join(', ') + '). Each change is applied in one atomic transaction, so none was half-applied.' : 'No interrupted changes were found at startup.' })),
        h('div', { class: 'card' }, h('h3', { text: 'Browser features CX uses' }), h('ul', { class: 'issues' },
          cap('IndexedDB', !!window.indexedDB), cap('Web Crypto (SHA-256)', !!(window.crypto && crypto.subtle), 'Requires HTTPS or localhost'), cap('Web Locks (cross-tab write safety)', !!navigator.locks, navigator.locks ? '' : 'Falls back to per-tab ordering'))),
        h('div', { class: 'card' }, h('h3', { text: 'Not implemented in Alpha 0.1' }), h('ul', { class: 'issues' },
          ['Remote computing and job execution', 'Sync between devices', 'Signed journal entries and keys', 'Budget grants and spending enforcement', 'AI agents', 'Binary files (text only, 5 MiB each)'].map((t) => h('li', { class: 'warn', text: t })))));
    }
    return { el, refresh: () => guard(refresh()) };
  } });

  CX.apps.register({ id: 'settings', title: 'Settings', icon: 'sliders', create(ctx) {
    const ws = () => ctx.ws();
    const theme = h('select', { class: 'select', id: 'set-theme', 'aria-label': 'Theme' }, h('option', { value: 'system', text: 'Match system' }), h('option', { value: 'dark', text: 'Dark' }), h('option', { value: 'light', text: 'Light' }));
    const size = h('input', { class: 'input', id: 'set-size', type: 'number', min: '10', max: '28', step: '1', 'aria-label': 'Editor font size' });
    const wrap = h('input', { type: 'checkbox', id: 'set-wrap' });
    const field = (l, id, c) => h('div', { class: 'field' }, h('label', { for: id, text: l }), c);
    const el = h('div', { class: 'pane' }, h('div', { class: 'list pad' },
      h('div', { class: 'card' }, h('h3', { text: 'Workspace settings' }), h('p', { class: 'muted', style: 'margin:0', text: 'These belong to the current workspace and are saved with it.' }),
        field('Theme', 'set-theme', theme), field('Editor font size (px)', 'set-size', size), h('label', { class: 'split', for: 'set-wrap' }, wrap, 'Wrap long lines in the editor')),
      h('div', { class: 'card' }, h('h3', { text: 'Window layout' }), h('button', { class: 'btn sm', onclick: () => guard(ctx.shell.setWorkspace(ws(), true)), text: 'Reset window layout' })),
      h('div', { class: 'card' }, h('h3', { text: 'About CX Alpha ' + CX.VERSION }), h('p', { class: 'muted mono', style: 'margin:0 0 6px', text: 'Build ' + CX.BUILD }), h('ul', { class: 'issues' },
        ['Everything runs in this browser. Data is stored in IndexedDB on this device.', 'The journal is hash-linked, unsigned and local. It detects accidental damage, not a determined rewrite.', 'No remote compute, no sync, no AI agents, no production security.', 'Files are text only, up to 5 MiB each.', 'Clearing site data deletes your workspaces. Export backups.'].map((t) => h('li', { class: 'info', text: t }))))));
    const apply = async (patch) => { try { await ws().updateSettings(patch); ctx.shell.applyTheme(ws().settings.theme); } catch (e) { ui.fail(e); load(); } };
    theme.addEventListener('change', () => apply({ theme: theme.value }));
    size.addEventListener('change', () => { const n = parseInt(size.value, 10); if (!(n >= 10 && n <= 28)) { ui.toast('Font size must be 10 to 28.', 'err'); load(); return; } apply({ fontSize: n }); });
    wrap.addEventListener('change', () => apply({ wordWrap: wrap.checked }));
    function load() { const s = ws().settings; theme.value = s.theme; size.value = s.fontSize; wrap.checked = s.wordWrap; }
    return { el, refresh: load };
  } });

  CX.apps.register({ id: 'terminal', title: 'Terminal', icon: 'term', short: 'Shell', create(ctx) {
    const ws = () => ctx.ws();
    let cwd = '/', hist = [], hi = 0;
    const out = h('div', { class: 'term-out', role: 'log', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Terminal output' });
    const input = h('input', { class: 'input mono', type: 'text', 'aria-label': 'Command', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'help' });
    const el = h('div', { class: 'pane' }, out, h('div', { class: 'term-in' }, h('span', { class: 'mono muted', style: 'align-self:center', text: '$' }), input, h('button', { class: 'btn sm primary', onclick: () => run(), text: 'Run' })));
    const say = (t) => { out.append(document.createTextNode(t + '\n')); out.scrollTop = out.scrollHeight; };
    say('CX terminal. Commands act on the real workspace and are journaled. Type help.');
    const abs = (p) => resolvePath(p || '.', cwd);
    const need = (p, type) => { const e = ws().stat(p); if (!e) throw new CX.util.CxError('E_NOT_FOUND', 'No such file or folder: ' + p); if (type && e.type !== type) throw new CX.util.CxError('E_TYPE', p + (type === 'dir' ? ' is not a folder' : ' is not a file')); return e; };
    const cmds = {
      help: () => say('help pwd ls [-l] [path] cd [path] cat file mkdir dir touch file rm [-r] path mv from to echo text > file find text stat path journal [n] verify snapshot [note] snapshots version clear'),
      pwd: () => say(cwd),
      ls: (a) => { const long = a[0] === '-l'; const p = abs(long ? a[1] : a[0]); need(p, 'dir'); const items = ws().list(p); say(items.length ? items.map((e) => long ? (e.type === 'dir' ? 'd ' : '- ') + String(e.size).padStart(8) + '  ' + e.name : e.name + (e.type === 'dir' ? '/' : '')).join(long ? '\n' : '  ') : '(empty)'); },
      cd: (a) => { const p = abs(a[0] || '/'); need(p, 'dir'); cwd = p; },
      cat: async (a) => { const p = abs(a[0]); need(p, 'file'); say(await ws().read(p)); },
      mkdir: async (a) => { await ws().createDir(abs(a[0])); },
      touch: async (a) => { const p = abs(a[0]); if (!ws().exists(p)) await ws().createFile(p, ''); },
      rm: async (a) => { const r = a[0] === '-r'; await ws().remove(abs(r ? a[1] : a[0]), { recursive: r }); },
      mv: async (a) => { await ws().rename(abs(a[0]), abs(a[1])); },
      stat: (a) => { const e = need(abs(a[0])); say(JSON.stringify({ path: e.path, type: e.type, size: e.size, rev: e.rev, hash: e.hash, modified: new Date(e.mtime).toISOString() }, null, 2)); },
      find: async (a) => { const r = await ws().search(a.join(' '), { content: false }); say(r.results.length ? r.results.map((x) => x.path).join('\n') : 'no matches'); },
      journal: async (a) => { const n = Math.max(1, Math.min(50, parseInt(a[0], 10) || 8)); (await ws().readJournal(n)).forEach((r) => say('#' + r.seq + '  ' + r.type + '  ' + shortHash(r.hash))); },
      verify: async () => { const v = await ws().verify(); say(v.valid ? 'OK: ' + v.count + ' records, head ' + shortHash(v.head) : 'FAILED: ' + v.issues.join(' | ')); },
      snapshot: async (a) => { const s = await ws().createSnapshot(a.join(' ')); say('snapshot ' + s.id + ' (' + s.files + ' files)'); },
      snapshots: async () => { const l = await ws().listSnapshots(); say(l.length ? l.map((s) => s.id + '  ' + new Date(s.created).toLocaleString() + '  ' + (s.note || '')).join('\n') : '(none)'); },
      version: () => say('CX Alpha ' + CX.VERSION),
      clear: () => { out.textContent = ''; },
    };
    async function run() {
      const line = input.value.trim(); input.value = ''; if (!line) return;
      hist.push(line); hi = hist.length; say('$ ' + line);
      try {
        const m = /^echo\s+(.*?)\s*>\s*(\S+)\s*$/.exec(line);
        if (m) { const p = abs(m[2]); if (!ws().exists(p)) await ws().createFile(p, m[1]); else await ws().writeFile(p, m[1]); }
        else if (/^echo(\s|$)/.test(line)) say(line.slice(5));
        else { const parts = line.split(/\s+/), f = cmds[parts[0]]; if (!f) say('Unknown command. Type help.'); else await f(parts.slice(1)); }
      } catch (e) { say('error: ' + ui.msg(e)); }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (hi > 0) input.value = hist[--hi]; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (hi < hist.length - 1) input.value = hist[++hi]; else { hi = hist.length; input.value = ''; } }
    });
    return { el, focus() { input.focus({ preventScroll: true }); } };
  } });
})();
