'use strict';
// Lumina Shell: windows, dock, workspace switching, status chips, theme, command palette.
CX.apps = { defs: [], register(d) { this.defs.push(d); } };
CX.shell = (function () {
  const { h, icon, debounce, fmtTime } = CX.util;
  const ui = CX.ui, store = CX.store, bus = CX.bus;
  const $ = (id) => document.getElementById(id);
  const S = { ws: null, wins: new Map(), z: 10, active: null, loading: false };
  const mobile = () => window.matchMedia('(max-width: 760px)').matches;
  const def = (id) => CX.apps.defs.find((d) => d.id === id);
  const ctx = { ws: () => S.ws, open: (id, o) => openApp(id, o), toast: ui.toast, ui, shell: null, layoutChanged: () => saveLayout() };

  // ---------- theme ----------
  function applyTheme(setting) {
    const root = document.documentElement;
    if (setting === 'dark' || setting === 'light') root.dataset.theme = setting; else delete root.dataset.theme;
    try { if (setting === 'dark' || setting === 'light') localStorage.setItem('cx.theme', setting); else localStorage.removeItem('cx.theme'); } catch (_) { /* optional convenience */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--canvas').trim() || '#080A10';
  }
  const effectiveDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  async function toggleTheme() { if (!S.ws) return; try { await S.ws.updateSettings({ theme: effectiveDark() ? 'light' : 'dark' }); applyTheme(S.ws.settings.theme); } catch (e) { ui.fail(e); } }

  // ---------- status chips ----------
  const setChip = (id, kind, text, title) => { const c = $(id); c.firstChild.className = 'dot ' + kind; c.lastChild.textContent = text; if (title) c.title = title; };
  let lastSaved = null;
  bus.on('store:busy', () => setChip('chip-store', 'busy', 'Saving…'));
  bus.on('store:idle', () => { if ($('chip-store').lastChild.textContent === 'Saving…') setChip('chip-store', lastSaved ? 'ok' : 'idle', lastSaved ? 'Saved' : 'Ready'); });
  bus.on('store:error', (e) => setChip('chip-store', 'err', 'Save failed', ui.msg(e)));
  const verifyBg = debounce(async () => {
    if (!S.ws) return;
    try {
      const r = await S.ws.verify();
      setChip('chip-journal', r.valid ? 'ok' : 'err', r.valid ? 'Journal ' + r.count : 'Journal check failed',
        r.valid ? 'Hash chain intact and matches the workspace (' + r.count + ' records). Local and unsigned: detects accidental damage and partial edits, not a full rewrite.' : r.issues[0]);
    } catch (e) { setChip('chip-journal', 'err', 'Journal check failed', ui.msg(e)); }
  }, 400);
  bus.on('ws:changed', (d) => {
    if (!S.ws || d.id !== S.ws.id) return;
    lastSaved = new Date().toLocaleTimeString(); setChip('chip-store', 'ok', 'Saved', 'Last saved at ' + lastSaved + '. All changes are written and verified in this browser.');
    verifyBg();
    requestAnimationFrame(() => S.wins.forEach((w) => { try { w.app.refresh && w.app.refresh(d); } catch (e) { console.error(e); } }));
  });

  bus.on('ws:deleted', (d) => { if (d.external) afterDelete(d.id).catch(ui.fail); });

  // ---------- windows ----------
  const desk = () => $('desktop');
  function defaultRect(id, n) {
    const r = desk().getBoundingClientRect(), W = r.width, H = r.height;
    if (id === 'files') return { x: 12, y: 12, w: Math.min(400, W * 0.4), h: H - 24 };
    if (id === 'editor') { const x = Math.min(424, W * 0.42); return { x, y: 12, w: Math.max(320, W - x - 12), h: H - 24 }; }
    const off = 24 * (n % 6);
    return { x: 60 + off, y: 40 + off, w: Math.min(560, W - 80), h: Math.min(460, H - 60) };
  }
  function clampRect(r) {
    const b = desk().getBoundingClientRect();
    const w = Math.max(280, Math.min(r.w, b.width)), hh = Math.max(180, Math.min(r.h, b.height));
    return { x: Math.max(-w + 80, Math.min(r.x, b.width - 80)), y: Math.max(0, Math.min(r.y, b.height - 40)), w, h: hh };
  }
  function place(w) { const r = w.rect; Object.assign(w.el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); }
  function focusWin(id) {
    const w = S.wins.get(id); if (!w) return;
    S.active = id; w.min = false; w.el.classList.remove('minimized'); w.el.style.zIndex = ++S.z;
    S.wins.forEach((x, k) => x.el.classList.toggle('active', k === id));
    updateDock(); saveLayout();
    if (w.app.focus) w.app.focus();
  }
  function openApp(id, o) {
    const d = def(id); if (!d || !S.ws) return null;
    if (S.wins.has(id)) { focusWin(id); const w = S.wins.get(id); if (o && w.app.open) w.app.open(o); return w.app; }
    const body = h('div', { class: 'win-body' });
    const el = h('section', { class: 'win', role: 'group', 'aria-label': d.title, dataset: { app: id } },
      h('div', { class: 'win-title' }, icon(d.icon), h('span', { class: 't', text: d.title }),
        h('button', { class: 'icon-btn', dataset: { act: 'min' }, 'aria-label': 'Minimise ' + d.title, title: 'Minimise' }, icon('min')),
        h('button', { class: 'icon-btn', dataset: { act: 'max' }, 'aria-label': 'Maximise ' + d.title, title: 'Maximise' }, icon('max')),
        h('button', { class: 'icon-btn', dataset: { act: 'close' }, 'aria-label': 'Close ' + d.title, title: 'Close' }, icon('x'))),
      body, h('div', { class: 'resize', 'aria-hidden': 'true' }));
    const saved = ((S.ws.ui && S.ws.ui.windows) || []).find((x) => x.app === id);
    const w = { id, el, body, app: null, min: false, max: false, rect: clampRect(saved ? { x: saved.x, y: saved.y, w: saved.w, h: saved.h } : defaultRect(id, S.wins.size)), prev: null };
    S.wins.set(id, w);
    desk().appendChild(el); place(w);
    const state = S.ws.ui && S.ws.ui.apps ? S.ws.ui.apps[id] : null;
    w.app = d.create(ctx, state, o);
    body.appendChild(w.app.el);
    wireWindow(w);
    if (saved && saved.max) toggleMax(id, true);
    focusWin(id);
    if (w.app.refresh) w.app.refresh();
    return w.app;
  }
  async function closeApp(id) {
    const w = S.wins.get(id); if (!w) return;
    if (w.app.canClose && !(await w.app.canClose())) return;
    if (w.app.destroy) w.app.destroy();
    w.el.remove(); S.wins.delete(id);
    if (S.active === id) { const last = [...S.wins.keys()].pop(); S.active = null; if (last) focusWin(last); }
    updateDock(); saveLayout(); updateEmpty();
  }
  function toggleMax(id, force) {
    const w = S.wins.get(id); if (!w) return;
    w.max = force !== undefined ? force : !w.max;
    if (w.max) { w.prev = { ...w.rect }; const b = desk().getBoundingClientRect(); w.rect = { x: 0, y: 0, w: b.width, h: b.height }; }
    else if (w.prev) w.rect = w.prev;
    place(w); saveLayout();
  }
  function wireWindow(w) {
    const title = w.el.querySelector('.win-title');
    w.el.addEventListener('pointerdown', () => { if (S.active !== w.id) focusWin(w.id); }, true);
    w.el.querySelector('[data-act="close"]').addEventListener('click', () => closeApp(w.id));
    w.el.querySelector('[data-act="min"]').addEventListener('click', () => { w.min = true; w.el.classList.add('minimized'); w.el.classList.remove('active'); if (S.active === w.id) S.active = null; updateDock(); saveLayout(); });
    w.el.querySelector('[data-act="max"]').addEventListener('click', () => toggleMax(w.id));
    title.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMax(w.id); });
    const drag = (el, onMove) => (e) => {
      if (mobile() || e.button > 0 || e.target.closest('button')) return;
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, r0 = { ...w.rect };
      const mv = (ev) => { onMove(r0, ev.clientX - sx, ev.clientY - sy); place(w); };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); saveLayout(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    };
    title.addEventListener('pointerdown', (e) => { if (w.max) return; drag(title, (r0, dx, dy) => { w.rect = clampRect({ ...r0, x: r0.x + dx, y: r0.y + dy }); })(e); });
    const rz = w.el.querySelector('.resize');
    rz.addEventListener('pointerdown', (e) => { if (w.max) return; drag(rz, (r0, dx, dy) => { w.rect = clampRect({ ...r0, w: r0.w + dx, h: r0.h + dy }); })(e); });
    title.addEventListener('keydown', (e) => {
      if (mobile() || w.max || !e.altKey) return;
      const step = e.shiftKey ? 40 : 12, k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (k) { e.preventDefault(); w.rect = clampRect({ ...w.rect, x: w.rect.x + k[0], y: w.rect.y + k[1] }); place(w); saveLayout(); }
    });
    title.tabIndex = 0; title.setAttribute('aria-label', w.id + ' window title. Alt plus arrow keys moves the window.');
  }
  function updateEmpty() {
    let n = desk().querySelector('.desk-empty');
    const none = !S.wins.size || [...S.wins.values()].every((w) => w.min);
    if (none && !n) desk().appendChild(h('div', { class: 'empty desk-empty', style: 'position:absolute;inset:0;display:grid;place-content:center', text: 'No apps open. Choose one from the dock.' }));
    else if (!none && n) n.remove();
  }
  // ---------- layout persistence ----------
  const doSave = () => {
    if (!S.ws || S.loading) return;
    const ui_ = { windows: [...S.wins.values()].map((w) => ({ app: w.id, ...(w.max && w.prev ? w.prev : w.rect), min: w.min, max: w.max, z: +w.el.style.zIndex || 0 })), active: S.active, apps: {} };
    S.wins.forEach((w) => { if (w.app.getState) ui_.apps[w.id] = w.app.getState(); });
    S.ws.saveUi(ui_).catch((e) => console.warn('layout not saved', e));
    updateEmpty();
  };
  const saveLayout = debounce(doSave, 250);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') doSave(); });
  window.addEventListener('pagehide', doSave);
  window.addEventListener('resize', debounce(() => { S.wins.forEach((w) => { w.rect = clampRect(w.rect); if (w.max) { const b = desk().getBoundingClientRect(); w.rect = { x: 0, y: 0, w: b.width, h: b.height }; } place(w); }); }, 100));

  // ---------- dock ----------
  function buildDock() {
    const dock = $('dock'); dock.textContent = '';
    CX.apps.defs.forEach((d) => dock.appendChild(h('button', { class: 'dock-btn', dataset: { app: d.id }, 'aria-label': d.title, title: d.title,
      onclick: () => { const w = S.wins.get(d.id); if (w && S.active === d.id && !mobile()) { w.el.querySelector('[data-act="min"]').click(); } else openApp(d.id); } }, icon(d.icon), h('span', { text: d.short || d.title }))));
  }
  function updateDock() {
    document.querySelectorAll('.dock-btn').forEach((b) => { const w = S.wins.get(b.dataset.app); b.classList.toggle('open', !!w); b.classList.toggle('focus', !!w && S.active === b.dataset.app); b.setAttribute('aria-pressed', String(!!w && S.active === b.dataset.app)); });
  }

  // ---------- workspaces ----------
  async function setWorkspace(ws, fresh) {
    S.loading = true;
    for (const id of [...S.wins.keys()]) { const w = S.wins.get(id); if (w.app.destroy) w.app.destroy(); w.el.remove(); S.wins.delete(id); }
    S.ws = ws; S.active = null;
    await store.setActive(ws.id);
    $('ws-name').textContent = ws.name; $('ws-switch').setAttribute('aria-label', 'Workspace: ' + ws.name + '. Switch workspace.');
    applyTheme(ws.settings.theme);
    const saved = ws.ui && ws.ui.windows && ws.ui.windows.length && !fresh ? ws.ui : null;
    if (saved) { [...saved.windows].sort((a, b) => a.z - b.z).forEach((x) => { if (def(x.app)) openApp(x.app); }); S.wins.forEach((w, k) => { const sv = saved.windows.find((x) => x.app === k); if (sv && sv.min) { w.min = true; w.el.classList.add('minimized'); w.el.classList.remove('active'); } }); if (saved.active && S.wins.has(saved.active) && !S.wins.get(saved.active).min) focusWin(saved.active); else { const vis = [...S.wins.entries()].filter(([, w]) => !w.min).pop(); if (vis) focusWin(vis[0]); } }
    else { openApp('files'); if (!mobile()) openApp('editor'); focusWin('files'); }
    S.loading = false; updateDock(); updateEmpty(); saveLayout();
    verifyBg();
  }
  async function switchWorkspace(id) {
    if (S.ws && S.ws.id === id) return;
    for (const w of S.wins.values()) if (w.app.canClose && !(await w.app.canClose())) return;
    try { await setWorkspace(await store.open(id)); ui.toast('Opened “' + S.ws.name + '”', 'ok'); } catch (e) { ui.fail(e); }
  }
  async function createWorkspaceFlow() {
    const taken = (await store.listWorkspaces()).map((w) => w.name.toLowerCase());
    const name = await ui.prompt('New workspace', 'Workspace name', '', { okLabel: 'Create', validate: (v) => (!v.trim() ? 'Enter a name.' : v.trim().length > 80 ? 'Use 80 characters or fewer.' : taken.includes(v.trim().toLowerCase()) ? 'A workspace with that name already exists.' : '') });
    if (name === null) return;
    try { const ws = await store.createWorkspace(name.trim()); await setWorkspace(ws, true); ui.toast('Created “' + ws.name + '”', 'ok'); } catch (e) { ui.fail(e); }
  }
  async function afterDelete(id) {
    if (!S.ws || S.ws.id !== id) return;
    const rest = await store.listWorkspaces();
    await setWorkspace(rest.length ? await store.open(rest[0].id) : await store.createWorkspace('My Workspace'), !rest.length);
  }

  // ---------- command palette ----------
  async function palette() {
    if (document.querySelector('dialog.pal')) return;
    const list = await store.listWorkspaces();
    const cmds = [
      ...CX.apps.defs.map((d) => ({ label: 'Open ' + d.title, ic: d.icon, run: () => openApp(d.id) })),
      { label: 'New workspace…', ic: 'plus', run: createWorkspaceFlow },
      ...list.filter((w) => !S.ws || w.id !== S.ws.id).map((w) => ({ label: 'Switch to ' + w.name, ic: 'grid', run: () => switchWorkspace(w.id) })),
      { label: 'Create snapshot', ic: 'snap', run: async () => { try { await S.ws.createSnapshot('Palette snapshot'); ui.toast('Snapshot created', 'ok'); } catch (e) { ui.fail(e); } } },
      { label: 'Export workspace', ic: 'download', run: async () => { try { const r = await CX.pkg.exportToFile(S.ws); if (r.status === 'saved') ui.toast('Exported ' + r.name, 'ok'); } catch (e) { ui.fail(e); } } },
      { label: 'Verify journal', ic: 'journal', run: () => { openApp('journal', { verify: true }); } },
      { label: 'Toggle light/dark theme', ic: 'moon', run: toggleTheme },
    ];
    await ui.modal((d, close) => {
      const input = h('input', { class: 'input', type: 'text', placeholder: 'Type a command…', 'aria-label': 'Command', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', style: 'border:0;border-radius:0;min-height:48px' });
      const box = h('div', { class: 'pal-list', id: 'pal-list', role: 'listbox' });
      let items = cmds, sel = 0;
      const draw = () => { box.textContent = ''; items.forEach((c, i) => box.appendChild(h('div', { class: 'pal-item', role: 'option', 'aria-selected': String(i === sel), onclick: () => { close(c); } }, icon(c.ic), h('span', { text: c.label })))); const s = box.children[sel]; if (s) s.scrollIntoView({ block: 'nearest' }); };
      input.addEventListener('input', () => { const q = input.value.toLowerCase(); items = cmds.filter((c) => c.label.toLowerCase().includes(q)); sel = 0; draw(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) close(items[sel]); }
      });
      d.append(input, box); draw(); setTimeout(() => input.focus(), 0);
    }, 'pal').then((c) => { if (c) c.run(); });
  }

  // ---------- workspace switcher ----------
  const switcher = () => openApp('workspaces');

  async function init(recovery) {
    ctx.shell = api;
    buildDock();
    $('btn-palette').appendChild(icon('cmd')); $('btn-theme').appendChild(icon('moon'));
    $('btn-palette').addEventListener('click', palette); $('btn-theme').addEventListener('click', toggleTheme); $('ws-switch').addEventListener('click', switcher);
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); } });
    window.addEventListener('beforeunload', (e) => { if ([...S.wins.values()].some((w) => w.app.isDirty && w.app.isDirty())) { e.preventDefault(); e.returnValue = ''; } });
    let ws = null, id = await store.getActive();
    if (id) { try { ws = await store.open(id); } catch (_) { ws = null; } }
    if (!ws) { const all = await store.listWorkspaces(); ws = all.length ? await store.open(all[0].id) : await store.createWorkspace('My Workspace'); }
    await setWorkspace(ws);
    setChip('chip-store', 'idle', 'Ready', 'Storage is ready.');
    if (recovery && recovery.discarded.length) ui.toast('Recovered from an interrupted write. ' + recovery.discarded.length + ' unfinished change(s) were discarded; nothing was half-applied.', 'warn');
  }
  const api = { init, openApp, closeApp, ws: () => S.ws, switchWorkspace, createWorkspaceFlow, afterDelete, setWorkspace, applyTheme, toggleTheme, palette, _state: S };
  return api;
})();
