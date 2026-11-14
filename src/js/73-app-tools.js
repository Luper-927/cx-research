'use strict';
// Search, Snapshots, Journal, Manifest.
(function () {
  const { h, icon, fmtBytes, fmtTime, shortHash, saveTextFile } = CX.util;
  const ui = CX.ui;
  const guard = (p) => Promise.resolve(p).catch(ui.fail);
  const issueList = (items, kind) => h('ul', { class: 'issues' }, items.map((t) => h('li', { class: kind, text: t })));

  CX.apps.register({ id: 'search', title: 'Search', icon: 'search', create(ctx, state, o) {
    const ws = () => ctx.ws();
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search names and contents', 'aria-label': 'Search text', autocomplete: 'off', style: 'flex:1;min-width:140px', value: (state && state.q) || '' });
    const nm = h('input', { type: 'checkbox', checked: true, id: 'srch-n' }), ct = h('input', { type: 'checkbox', checked: true, id: 'srch-c' }), cs = h('input', { type: 'checkbox', id: 'srch-s' });
    const out = h('div', { class: 'list', role: 'list', 'aria-label': 'Search results' });
    const info = h('div', { class: 'muted pad', role: 'status', 'aria-live': 'polite', style: 'padding:6px 12px' });
    const go = h('button', { class: 'btn primary sm', onclick: () => guard(run()) }, icon('search'), h('span', { text: 'Search' }));
    const lab = (c, id, t) => h('label', { for: id, class: 'split', style: 'gap:4px' }, c, t);
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar' }, q, go), h('div', { class: 'toolbar' }, lab(nm, 'srch-n', 'File names'), lab(ct, 'srch-c', 'Contents'), lab(cs, 'srch-s', 'Match case')), info, out);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(run()); });
    let token = 0;
    async function run() {
      const text = q.value; out.textContent = '';
      if (!text) { info.textContent = 'Enter text to search for.'; return; }
      const my = ++token; info.textContent = 'Searching…';
      const r = await ws().search(text, { names: nm.checked, content: ct.checked, caseSensitive: cs.checked });
      if (my !== token) return;
      info.textContent = r.results.length + ' result(s)' + (r.truncated ? ' (showing the first 200)' : '') + ' · searched names of ' + ws().all().length + ' item(s) and contents of ' + r.searched + ' file(s). Files over 1 MiB are skipped.';
      if (!r.results.length) out.append(h('div', { class: 'empty', text: 'No matches.' }));
      r.results.forEach((x) => out.append(h('div', { class: 'row', role: 'listitem', tabindex: '0',
        onclick: () => open(x), onkeydown: (e) => { if (e.key === 'Enter') open(x); } },
      icon(x.type === 'dir' ? 'folder' : 'file'), h('span', { class: 'n', text: x.path + (x.line ? ':' + x.line : '') }), h('span', { class: 'm', text: x.kind === 'content' ? x.text : x.kind }))));
    }
    function open(x) { if (x.type === 'dir') ctx.open('files', { cwd: x.path }); else ctx.open('editor', { path: x.path }); }
    if (o && o.q) { q.value = o.q; }
    return { el, getState: () => ({ q: q.value }), focus() { q.focus({ preventScroll: true }); }, open(x) { if (x && x.q) { q.value = x.q; guard(run()); } } };
  } });

  CX.apps.register({ id: 'snapshots', title: 'Snapshots', icon: 'snap', short: 'Snaps', create(ctx) {
    const ws = () => ctx.ws();
    const note = h('input', { class: 'input', type: 'text', placeholder: 'Optional note', 'aria-label': 'Snapshot note', maxlength: '200', style: 'flex:1;min-width:140px' });
    const list = h('div', { class: 'list pad', style: 'padding:6px 12px' });
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar' }, note, h('button', { class: 'btn primary sm', onclick: () => guard(create()) }, icon('snap'), h('span', { text: 'Create snapshot' }))), list);
    async function create() { const s = await ws().createSnapshot(note.value.trim()); note.value = ''; ui.toast('Snapshot created (' + s.files + ' files).', 'ok'); }
    async function restore(s) {
      const ok = await ui.confirm('Restore this snapshot?', 'The workspace will return to its state from ' + fmtTime(s.created) + ' (' + s.files + ' files). CX takes an automatic snapshot of the current state first, so you can undo this.', { okLabel: 'Restore', danger: true });
      if (!ok) return; const r = await ws().restoreSnapshot(s.id); ui.toast('Restored. The previous state was saved as an automatic snapshot.', 'ok'); return r;
    }
    async function del(s) { if (!(await ui.confirm('Delete snapshot?', 'This snapshot will be deleted. Files that only it still referenced are removed from storage.', { danger: true, okLabel: 'Delete' }))) return; await ws().deleteSnapshot(s.id); }
    async function refresh() {
      const snaps = await ws().listSnapshots(); list.textContent = '';
      if (!snaps.length) list.append(h('div', { class: 'empty', text: 'No snapshots yet. A snapshot records every file and folder so you can return to this moment.' }));
      snaps.forEach((s) => list.append(h('div', { class: 'ws-item', 'data-snap': s.id },
        h('div', { style: 'min-width:0;flex:1' }, h('div', { text: s.note || '(no note)', style: 'font-weight:600;overflow-wrap:anywhere' }),
          h('div', { class: 'muted mono', text: fmtTime(s.created) + ' · ' + s.files + ' files · ' + s.dirs + ' folders · ' + fmtBytes(s.bytes) + ' · root ' + shortHash(s.root) }),
          s.auto ? h('span', { class: 'badge', text: 'automatic' }) : null),
        h('div', { class: 'split' }, h('button', { class: 'btn sm', onclick: () => guard(restore(s)), text: 'Restore' }), h('button', { class: 'btn sm danger', onclick: () => guard(del(s)), text: 'Delete' })))));
    }
    return { el, refresh: () => guard(refresh()), focus() { note.focus({ preventScroll: true }); } };
  } });

  CX.apps.register({ id: 'journal', title: 'Journal', icon: 'journal', create(ctx, state, o) {
    const ws = () => ctx.ws();
    const result = h('div', { role: 'status', 'aria-live': 'polite' });
    const list = h('div', { style: 'padding:0 12px 12px' });
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar' }, h('button', { class: 'btn primary sm', onclick: () => guard(verify()) }, icon('check'), h('span', { text: 'Verify journal' }))),
      h('div', { class: 'list' }, h('div', { class: 'pad' }, h('div', { class: 'card', style: 'margin-top:0' }, h('h3', { text: 'What this journal is' }),
        h('p', { class: 'muted', style: 'margin:0', text: 'Every change is recorded in a hash-linked chain stored on this device. It is tamper-evident for accidental damage and partial edits. It is not signed, not anchored anywhere else, and cannot stop someone who can rewrite this browser’s storage from replacing the whole chain.' })), result), list));
    async function verify() {
      result.textContent = ''; const r = await ws().verify();
      result.append(h('div', { class: 'card', style: 'margin:0' }, h('h3', {}, h('span', { class: 'badge ' + (r.valid ? 'ok' : 'err'), text: r.valid ? 'VERIFIED' : 'FAILED' }), ' ', r.count + ' record(s)'),
        h('div', { class: 'mono muted', style: 'overflow-wrap:anywhere', text: 'Head ' + r.head }), r.issues.length ? issueList(r.issues, 'err') : h('p', { class: 'muted', style: 'margin:6px 0 0', text: 'The chain is intact, each record matches its hash, and the files match the last record.' })));
    }
    async function refresh() {
      const recs = (await ws().readJournal(200)).reverse(); list.textContent = '';
      recs.forEach((r) => list.append(h('details', { class: 'j-item' }, h('summary', {}, h('strong', { text: r.type }), h('span', { class: 'muted mono', text: '#' + r.seq + ' · ' + fmtTime(r.ts) }), r.subject ? h('span', { class: 'mono', style: 'overflow-wrap:anywhere', text: String(r.subject).slice(0, 60) }) : null),
        h('pre', { text: JSON.stringify({ hash: r.hash, prev: r.prev, stateRoot: r.stateRoot, data: r.data }, null, 2) }))));
      if (!recs.length) list.append(h('div', { class: 'empty', text: 'No records.' }));
    }
    if (o && o.verify) guard(verify());
    return { el, refresh: () => guard(refresh()), open(x) { if (x && x.verify) guard(verify()); } };
  } });

  CX.apps.register({ id: 'manifest', title: 'Manifest', icon: 'manifest', create(ctx, state) {
    const ws = () => ctx.ws(), M = CX.manifest;
    const ta = h('textarea', { class: 'textarea', spellcheck: 'false', 'aria-label': 'cx.workspace.json', style: 'min-height:180px;flex:none;height:210px' });
    const report = h('div', { role: 'status', 'aria-live': 'polite' });
    const picker = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', 'aria-hidden': 'true', tabIndex: -1 });
    const bSave = h('button', { class: 'btn primary sm', onclick: () => guard(save()) }, icon('save'), h('span', { text: 'Save' }));
    const bNew = h('button', { class: 'btn sm', onclick: () => guard(fromTemplate()) }, icon('plus'), h('span', { text: 'Create from template' }));
    const body = h('div', { class: 'list' }, h('div', { class: 'pad' }, h('p', { class: 'muted', style: 'margin:0 0 8px', text: 'The manifest is the file ' + M.PATH + ' in this workspace. CX reads and validates it. It never runs anything the manifest describes.' }), ta, report));
    const el = h('div', { class: 'pane' }, h('div', { class: 'toolbar' }, bNew, bSave, h('button', { class: 'btn sm', onclick: () => picker.click() }, icon('upload'), h('span', { text: 'Import' })), h('button', { class: 'btn sm', onclick: () => guard(exp()) }, icon('download'), h('span', { text: 'Export' })), picker), body);
    let rep = null, loaded = null, dirty = false;
    picker.addEventListener('change', () => guard(imp(picker.files[0])).finally(() => { picker.value = ''; }));
    async function validate() { rep = await M.validate(ta.value); draw(); }
    const vdeb = CX.util.debounce(() => guard(validate()), 250);
    ta.addEventListener('input', () => { dirty = ta.value !== loaded; vdeb(); });
    function draw() {
      report.textContent = '';
      if (!ta.value.trim()) { report.append(h('div', { class: 'empty', text: 'No manifest in this workspace yet. Create one from the template, import a file, or type one here.' })); bSave.disabled = true; return; }
      bSave.disabled = !rep || !rep.ok;
      const head = h('div', { class: 'card' }, h('h3', {}, h('span', { class: 'badge ' + (rep.ok ? 'ok' : 'err'), text: rep.ok ? 'VALID' : rep.errors.length + ' ERROR(S)' }), ' ', rep.manifest && rep.manifest.name ? String(rep.manifest.name) : ''));
      if (rep.errors.length) head.append(h('p', { class: 'muted', style: 'margin:0', text: 'Errors' }), h('ul', { class: 'issues' }, rep.errors.map((e) => h('li', { class: 'err' }, h('code', { class: 'mono', text: e.path || '(file)' }), ' ' + e.message))));
      if (rep.warnings.length) head.append(h('p', { class: 'muted', style: 'margin:8px 0 0', text: 'Warnings' }), h('ul', { class: 'issues' }, rep.warnings.map((e) => h('li', { class: 'warn' }, h('code', { class: 'mono', text: e.path }), ' ' + e.message))));
      if (rep.unsupported.length) head.append(h('p', { class: 'muted', style: 'margin:8px 0 0', text: 'Declared but not supported in Alpha 0.1 (kept, not acted on)' }), h('ul', { class: 'issues' }, rep.unsupported.map((e) => h('li', { class: 'info' }, h('strong', { text: e.feature }), ' at ', h('code', { class: 'mono', text: e.path }), '. ' + e.reason))));
      if (rep.unknown.length) head.append(h('p', { class: 'muted', style: 'margin:8px 0 0', text: 'Unknown fields (preserved as written)' }), h('div', { class: 'mono', text: rep.unknown.join(', ') }));
      if (rep.hash) head.append(h('div', { class: 'mono muted', style: 'margin-top:8px;overflow-wrap:anywhere', text: 'Manifest hash ' + rep.hash }));
      report.append(head);
    }
    async function load() {
      const e = ws().stat(M.PATH);
      if (e && e.type === 'file') { const t = await ws().read(M.PATH); if (!dirty || t !== loaded) { if (!dirty) { ta.value = t; } loaded = t; } }
      else if (!dirty) { ta.value = ''; loaded = ''; }
      await validate(); bNew.disabled = !!(e && e.type === 'file');
    }
    async function write(text, via) {
      const r = await M.validate(text);
      const e = ws().stat(M.PATH);
      if (e && e.type !== 'file') throw new CX.util.CxError('E_PATH', M.PATH + ' exists but is not a file.');
      if (e) await ws().writeFile(M.PATH, text, { type: 'manifest.updated', data: { manifestHash: r.hash, via } });
      else { await ws().createFile(M.PATH, text); }
      loaded = text; dirty = false;
    }
    async function save() { await validate(); if (!rep.ok) throw new CX.util.CxError('E_INVALID', 'Fix the ' + rep.errors.length + ' error(s) first. Nothing was saved.'); await write(ta.value, 'editor'); ui.toast('Manifest saved.', 'ok'); }
    async function fromTemplate() { if (ws().exists(M.PATH)) return; await write(M.template(ws().name), 'template'); ta.value = loaded; await validate(); ui.toast('Created ' + M.PATH, 'ok'); }
    async function imp(file) {
      if (!file) return;
      if (file.size > 1024 * 1024) throw new CX.util.CxError('E_TOO_LARGE', 'Manifests over 1 MiB are not supported.');
      const text = await file.text(), r = await M.validate(text);
      if (!r.ok) { await ui.notice('Import rejected', 'This manifest has ' + r.errors.length + ' error(s). Nothing was changed.', r.errors.map((e) => (e.path ? e.path + ': ' : '') + e.message)); return; }
      if (ws().exists(M.PATH) && !(await ui.confirm('Replace the manifest?', 'This workspace already has ' + M.PATH + '. The old version stays in the journal history and in any snapshots.', { danger: true, okLabel: 'Replace' }))) return;
      await write(text, 'import'); ta.value = text; await validate(); ui.toast('Manifest imported.' + (r.unsupported.length ? ' ' + r.unsupported.length + ' feature(s) are declared but not supported yet.' : ''), 'ok');
    }
    async function exp() {
      if (!ws().exists(M.PATH)) throw new CX.util.CxError('E_NOT_FOUND', 'There is no saved manifest to export.');
      if (dirty && !(await ui.confirm('Export the saved version?', 'You have unsaved edits. Only the saved manifest will be exported.', { okLabel: 'Export saved version' }))) return;
      const s = await saveTextFile('cx.workspace.json', await ws().read(M.PATH)); if (s === 'saved') ui.toast('Manifest exported.', 'ok');
    }
    return { el, refresh: () => guard(load()), isDirty: () => dirty, getState: () => ({}), focus() { ta.focus({ preventScroll: true }); },
      async canClose() { return !dirty || ui.confirm('Discard manifest edits?', 'You have unsaved manifest edits.', { danger: true, okLabel: 'Discard' }); } };
  } });
})();
