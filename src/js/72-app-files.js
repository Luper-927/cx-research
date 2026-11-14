'use strict';
// Files explorer and text editor.
(function () {
  const { h, icon, fmtBytes, fmtTime, shortHash, joinPath, parentOf, nameOf, validName } = CX.util;
  const ui = CX.ui;

  CX.apps.register({ id: 'files', title: 'Files', icon: 'folder', create(ctx, state) {
    let cwd = (state && state.cwd) || '/', sel = (state && state.sel) || null;
    const ws = () => ctx.ws();
    const crumbs = h('div', { class: 'crumbs', role: 'navigation', 'aria-label': 'Folder path' });
    const list = h('div', { class: 'list', role: 'listbox', tabindex: '0', 'aria-label': 'Files and folders' });
    const meta = h('dl', { class: 'meta', 'aria-label': 'Details of the selected item' });
    const b = (label, ic, fn) => h('button', { class: 'btn sm', onclick: fn, 'aria-label': label, title: label }, icon(ic), h('span', { text: label }));
    const bUp = b('Up', 'up', () => go(parentOf(cwd) || '/'));
    const bFile = b('New file', 'plus', () => guard(newEntry('file')));
    const bDir = b('New folder', 'folder', () => guard(newEntry('dir')));
    const bUp2 = b('Upload', 'upload', () => picker.click());
    const bRen = b('Rename', 'rename', () => guard(rename()));
    const bDel = b('Delete', 'trash', () => guard(remove()));
    const picker = h('input', { type: 'file', multiple: true, class: 'hidden', 'aria-hidden': 'true', tabIndex: -1 });
    picker.addEventListener('change', () => guard(upload(picker.files)).finally(() => { picker.value = ''; }));
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'File actions' }, bUp, bFile, bDir, bUp2, bRen, bDel, picker), crumbs, list, meta);
    const guard = (p) => Promise.resolve(p).catch(ui.fail);

    function go(p) { cwd = p; sel = null; draw(); save(); }
    const save = () => ctx.layoutChanged();
    function select(p, focusRow) {
      sel = p;
      list.querySelectorAll('.row').forEach((r) => { const on = r.dataset.path === p; r.setAttribute('aria-selected', String(on)); if (on && focusRow) r.scrollIntoView({ block: 'nearest' }); });
      drawMeta(); bRen.disabled = bDel.disabled = !p;
    }
    function openEntry(p) { const e = ws().stat(p); if (!e) return; if (e.type === 'dir') go(p); else ctx.open('editor', { path: p }); }
    function drawMeta() {
      meta.textContent = '';
      const e = sel && ws().stat(sel);
      if (!e) { meta.append(h('dt', { text: 'Folder' }), h('dd', { text: cwd + ' · ' + ws().list(cwd).length + ' item(s)' })); return; }
      const rows = [['Path', e.path], ['Type', e.type === 'dir' ? 'Folder' : 'Text file'], ['Size', e.type === 'dir' ? ws().list(e.path).length + ' item(s)' : fmtBytes(e.size) + ' (' + e.size + ' bytes)'],
        ['Modified', fmtTime(e.mtime)], ['Created', fmtTime(e.ctime)], ['Revision', String(e.rev)]];
      if (e.hash) rows.push(['SHA-256', e.hash.slice(7, 39) + '…']);
      rows.forEach(([k, v]) => meta.append(h('dt', { text: k }), h('dd', { text: v })));
    }
    function draw() {
      if (!ws().stat(cwd) || ws().stat(cwd).type !== 'dir') cwd = '/';
      crumbs.textContent = '';
      const parts = cwd === '/' ? [] : cwd.slice(1).split('/');
      crumbs.append(h('button', { onclick: () => go('/'), 'aria-label': 'Root folder', text: '/' }));
      let acc = '';
      parts.forEach((s, i) => { acc += '/' + s; const p = acc; crumbs.append(h('span', { class: 'muted', text: '›' }), h('button', { onclick: () => go(p), text: s, 'aria-current': i === parts.length - 1 ? 'page' : null })); });
      list.textContent = '';
      const items = ws().list(cwd);
      if (!items.length) list.append(h('div', { class: 'empty', text: 'This folder is empty.' }));
      items.forEach((e) => list.append(h('div', { class: 'row', role: 'option', 'aria-selected': String(e.path === sel), dataset: { path: e.path }, onclick: () => select(e.path), ondblclick: () => openEntry(e.path) },
        icon(e.type === 'dir' ? 'folder' : 'file'), h('span', { class: 'n', text: e.name }), h('span', { class: 'm', text: e.type === 'dir' ? 'folder' : fmtBytes(e.size) }))));
      bUp.disabled = cwd === '/';
      if (sel && !ws().stat(sel)) sel = null;
      bRen.disabled = bDel.disabled = !sel; drawMeta();
    }
    list.addEventListener('keydown', (e) => {
      const rows = [...list.querySelectorAll('.row')]; const i = rows.findIndex((r) => r.dataset.path === sel);
      if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) select(rows[Math.min(rows.length - 1, i + 1)].dataset.path, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) select(rows[Math.max(0, i - 1)].dataset.path, true); }
      else if (e.key === 'Enter' && sel) { e.preventDefault(); openEntry(sel); }
      else if (e.key === 'F2' && sel) { e.preventDefault(); guard(rename()); }
      else if (e.key === 'Delete' && sel) { e.preventDefault(); guard(remove()); }
      else if (e.key === 'Backspace' && cwd !== '/') { e.preventDefault(); go(parentOf(cwd) || '/'); }
    });
    const nameCheck = (dir, ignore) => (v) => { const n = v.trim(); if (!validName(n)) return 'Names cannot be empty, contain “/”, or be “.” or “..”.'; if (n !== ignore && ws().exists(joinPath(dir, n))) return '“' + n + '” already exists here.'; return ''; };
    async function newEntry(type) {
      const n = await ui.prompt(type === 'dir' ? 'New folder' : 'New file', 'Name', '', { okLabel: 'Create', validate: nameCheck(cwd) });
      if (n === null) return;
      const p = joinPath(cwd, n.trim());
      if (type === 'dir') await ws().createDir(p); else await ws().createFile(p, '');
      draw(); select(p, true);
      if (type === 'file') ctx.open('editor', { path: p });
    }
    async function rename() {
      const e = sel && ws().stat(sel); if (!e) return;
      const n = await ui.prompt('Rename', 'New name', e.name, { okLabel: 'Rename', validate: nameCheck(parentOf(e.path), e.name) });
      if (n === null || n.trim() === e.name) return;
      const np = joinPath(parentOf(e.path), n.trim());
      await ws().rename(e.path, np); sel = np; draw(); select(np, true);
    }
    async function remove() {
      const e = sel && ws().stat(sel); if (!e) return;
      const count = e.type === 'dir' ? ws().all().filter((x) => x.path.startsWith(e.path + '/')).length : 0;
      const ok = await ui.confirm('Delete ' + (e.type === 'dir' ? 'folder' : 'file') + '?', e.type === 'dir' && count ? '“' + e.path + '” and the ' + count + ' item(s) inside it will be deleted. Earlier snapshots keep their copies.' : '“' + e.path + '” will be deleted. Earlier snapshots keep their copies.', { danger: true, okLabel: 'Delete' });
      if (!ok) return;
      await ws().remove(e.path, { recursive: true }); sel = null; draw();
    }
    async function upload(files) {
      const dec = new TextDecoder('utf-8', { fatal: true }); const issues = []; let ok = 0;
      for (const f of files) {
        try {
          if (!validName(f.name)) throw new Error('unsupported file name');
          if (f.size > CX.store.MAX_FILE) throw new Error('over the 5 MiB limit');
          const text = dec.decode(await f.arrayBuffer());
          const p = joinPath(cwd, f.name);
          if (ws().exists(p)) throw new Error('already exists here');
          await ws().createFile(p, text); ok++;
        } catch (e) { issues.push(f.name + ': ' + (e instanceof TypeError ? 'not a text file (binary files are not supported in Alpha 0.1)' : ui.msg(e))); }
      }
      if (ok) ui.toast('Added ' + ok + ' file(s).', 'ok');
      if (issues.length) ui.notice('Some files were not added', 'Nothing was overwritten.', issues);
      draw();
    }
    return { el, refresh() { draw(); }, getState: () => ({ cwd, sel }), focus() { list.focus({ preventScroll: true }); },
      open(o) { if (o && o.cwd) { cwd = o.cwd; sel = o.sel || null; draw(); } } };
  } });

  CX.apps.register({ id: 'editor', title: 'Editor', icon: 'edit', create(ctx, state, initial) {
    const ws = () => ctx.ws();
    let tabs = [], active = -1;
    const tabbar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Open files' });
    const ta = h('textarea', { class: 'textarea', spellcheck: 'false', autocapitalize: 'none', autocomplete: 'off', 'aria-label': 'File contents', style: 'flex:1;border:0;border-radius:0;min-height:0' });
    const empty = h('div', { class: 'empty', style: 'flex:1', text: 'Open a file from Files, or search, to edit it here.' });
    const status = h('div', { class: 'statusbar', 'aria-live': 'polite' });
    const bSave = h('button', { class: 'btn sm primary', onclick: () => guard(save()), 'aria-label': 'Save (Ctrl+S)', title: 'Save (Ctrl+S)' }, icon('save'), h('span', { text: 'Save' }));
    const bRevert = h('button', { class: 'btn sm', onclick: () => guard(revert()), 'aria-label': 'Revert to saved' }, h('span', { text: 'Revert' }));
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar' }, bSave, bRevert), tabbar, ta, empty, status);
    const guard = (p) => Promise.resolve(p).catch(ui.fail);
    const cur = () => tabs[active] || null;

    function style() { const s = ws().settings; ta.style.fontSize = s.fontSize + 'px'; ta.style.lineHeight = '1.6'; ta.wrap = s.wordWrap ? 'soft' : 'off'; ta.style.whiteSpace = s.wordWrap ? 'pre-wrap' : 'pre'; ta.style.overflowX = s.wordWrap ? 'hidden' : 'auto'; }
    function drawTabs() {
      tabbar.textContent = '';
      tabs.forEach((t, i) => tabbar.append(h('button', { class: 'tab', role: 'tab', 'aria-selected': String(i === active), title: t.path, onclick: () => activate(i) },
        h('span', { text: nameOf(t.path) + (t.dirty ? ' •' : '') }),
        h('span', { class: 'icon-btn', role: 'button', tabindex: '0', 'aria-label': 'Close ' + nameOf(t.path), style: 'width:24px;height:24px', onclick: (e) => { e.stopPropagation(); guard(closeTab(i)); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); guard(closeTab(i)); } } }, icon('x')))));
      const has = !!cur();
      ta.classList.toggle('hidden', !has); empty.classList.toggle('hidden', has); bSave.disabled = bRevert.disabled = !has;
      drawStatus();
    }
    function drawStatus() {
      const t = cur(); status.textContent = '';
      if (!t) return;
      const lines = t.text.split('\n').length, bytes = CX.util.byteLength(t.text);
      const state = t.missing ? 'Deleted elsewhere. Saving recreates it.' : t.changed ? 'Changed elsewhere. Saving asks before overwriting.' : t.dirty ? 'Unsaved changes' : 'Saved';
      [t.path, lines + ' lines', fmtBytes(bytes), 'rev ' + t.rev, state].forEach((x) => status.append(h('span', { text: x })));
    }
    function activate(i) { if (cur()) cur().text = ta.value; active = i; if (cur()) { ta.value = cur().text; } drawTabs(); ctx.layoutChanged(); if (cur() && ta.offsetParent) ta.focus({ preventScroll: true }); }
    async function openFile(path) {
      const i = tabs.findIndex((t) => t.path === path);
      if (i >= 0) return activate(i);
      const e = ws().stat(path); if (!e || e.type !== 'file') throw new CX.util.CxError('E_NOT_FOUND', 'File not found: ' + path);
      const text = await ws().read(path);
      tabs.push({ path, text, orig: text, rev: e.rev, dirty: false, missing: false, changed: false });
      activate(tabs.length - 1);
    }
    async function save() {
      const t = cur(); if (!t) return;
      t.text = ta.value;
      let e;
      if (!ws().exists(t.path)) {
        if (!(await ui.confirm('Recreate file?', '“' + t.path + '” was deleted. Save your text as a new file?', { okLabel: 'Recreate' }))) return;
        e = await ws().createFile(t.path, t.text);
      } else {
        try { e = await ws().writeFile(t.path, t.text, { expectRev: t.rev }); }
        catch (err) {
          if (err.code !== 'E_CONFLICT') throw err;
          if (!(await ui.confirm('File changed elsewhere', '“' + t.path + '” changed since you opened it. Overwrite it with your version? The other version stays in the journal history and any snapshots.', { danger: true, okLabel: 'Overwrite' }))) return;
          e = await ws().writeFile(t.path, t.text);
        }
      }
      t.orig = t.text; t.rev = e.rev; t.dirty = false; t.missing = false; t.changed = false; drawTabs(); ui.toast('Saved ' + nameOf(t.path), 'ok');
    }
    async function revert() {
      const t = cur(); if (!t) return;
      if (t.dirty && !(await ui.confirm('Discard changes?', 'Your unsaved edits to “' + nameOf(t.path) + '” will be lost.', { danger: true, okLabel: 'Discard' }))) return;
      const e = ws().stat(t.path); if (!e) throw new CX.util.CxError('E_NOT_FOUND', 'The file no longer exists.');
      t.text = t.orig = await ws().read(t.path); t.rev = e.rev; t.dirty = false; t.changed = false; ta.value = t.text; drawTabs();
    }
    async function closeTab(i) {
      const t = tabs[i];
      if (t.dirty && !(await ui.confirm('Close without saving?', '“' + nameOf(t.path) + '” has unsaved changes.', { danger: true, okLabel: 'Discard changes' }))) return;
      if (i === active) cur().text = ta.value;
      tabs.splice(i, 1);
      active = tabs.length ? Math.min(i, tabs.length - 1) : -1;
      ta.value = cur() ? cur().text : ''; drawTabs(); ctx.layoutChanged();
    }
    ta.addEventListener('input', () => { const t = cur(); if (!t) return; t.text = ta.value; const d = t.text !== t.orig; if (d !== t.dirty) { t.dirty = d; drawTabs(); } else drawStatus(); });
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); guard(save()); } });
    async function refresh() {
      style();
      for (const t of tabs) {
        const e = ws().stat(t.path);
        if (!e) { t.missing = true; continue; }
        t.missing = false;
        if (e.rev !== t.rev) {
          if (!t.dirty) { try { t.text = t.orig = await ws().read(t.path); t.rev = e.rev; t.changed = false; if (t === cur()) ta.value = t.text; } catch (_) { t.changed = true; } }
          else t.changed = true;
        }
      }
      drawTabs();
    }
    (async () => {
      const paths = [...((state && state.tabs) || [])]; if (initial && initial.path && !paths.includes(initial.path)) paths.push(initial.path);
      for (const p of paths) { try { await openFile(p); } catch (_) { /* file gone */ } }
      if (state && Number.isInteger(state.active) && tabs[state.active]) activate(state.active);
      if (initial && initial.path) { const i = tabs.findIndex((t) => t.path === initial.path); if (i >= 0) activate(i); }
      drawTabs(); style();
    })();
    return { el, refresh, isDirty: () => tabs.some((t) => t.dirty), getState: () => ({ tabs: tabs.map((t) => t.path), active }), focus() { if (cur() && ta.offsetParent) ta.focus({ preventScroll: true }); },
      open(o) { if (o && o.path) guard(openFile(o.path)); },
      async canClose() { const d = tabs.filter((t) => t.dirty).length; return !d || ui.confirm('Discard unsaved changes?', d + ' file(s) have unsaved edits.', { danger: true, okLabel: 'Discard' }); } };
  } });
})();
