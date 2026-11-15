// End-to-end tests for CX Alpha 0.1. Drives the built dist/index.html in real Chromium.
// Run: NODE_PATH=<dir containing playwright> node tests/run.js
const pw = require('playwright');
const BROWSER = process.env.BROWSER || 'chromium', BT = pw[BROWSER];
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const HTML = path.join(__dirname, '../dist/index.html');
// CX_URL=<published url>  run against a deployed copy instead of a local one
// PREFIX=/cx-research/    serve locally under a sub-path, like GitHub project pages
// BROWSER=chromium|firefox|webkit   EXPECT_BUILD=<build id>   ALLOW_FONTS=1 lets Google Fonts load
const REMOTE = process.env.CX_URL ? process.env.CX_URL.replace(/\/?$/, '/') : null;
const LEGACY = [path.join(__dirname, '../legacy/cx-v0.9.html'), path.join(__dirname, 'fixtures/cx-v0.9.html')].find((f) => fs.existsSync(f));
const srv = REMOTE ? null : require('./serve')({ index: HTML, legacy: LEGACY, prefix: process.env.PREFIX || '/' });
const blockFonts = (p) => (process.env.ALLOW_FONTS ? Promise.resolve() : p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()));
const skip = (name, why) => { results.push({ name, ok: true, skipped: why }); console.log('SKIP  ' + name + ' (' + why + ')'); };
const results = []; let browser, URL_;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const check = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };

async function newPage(opts) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...(opts || {}) });
  const p = await ctx.newPage(); p.errors = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  p.on('pageerror', (e) => p.errors.push('PAGEERROR ' + e.message));
  await blockFonts(p);
  await boot(p); return p;
}
const boot = async (p) => { await p.goto(URL_); await p.waitForSelector('html[data-cx-ready="1"]', { timeout: 10000 }); };
const ev = (p, fn, arg) => p.evaluate(fn, arg);
async function test(name, fn) {
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
  const t0 = Date.now();
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT after 90s (a dialog or wait never resolved)')), 90000))]); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, ok: false, err: e.message.split('\n')[0] }); console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
}
const dlgOk = (p) => p.click('dialog.dlg .dlg-actions button:last-child');
const dlgFill = async (p, text) => { await p.fill('dialog.dlg input', text); await dlgOk(p); await p.waitForSelector('dialog.dlg', { state: 'detached' }); };
const win = (id) => '.win[data-app="' + id + '"]';
const openApp = (p, id) => ev(p, (i) => { CX.shell.openApp(i); }, id);
const files = (p) => ev(p, () => CX.shell.ws().all().map((e) => e.path + (e.type === 'dir' ? '/' : '')).sort());
const read = (p, f) => ev(p, (x) => CX.shell.ws().read(x), f);
const journalOk = (p) => ev(p, async () => { const r = await CX.shell.ws().verify(); return r; });
async function newFileUI(p, name) { await openApp(p, 'files'); await p.click(win('files') + ' button:has-text("New file")'); await dlgFill(p, name); }
const waitText = (p, sel, re) => p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s) && document.querySelector(s).textContent), [sel, re.source], { timeout: 5000 });

function v09Fixture(tamper) {
  const GEN = '0'.repeat(64), rf = (e) => (typeof e.c === 'string' ? e.c : typeof e.content === 'string' ? e.content : '');
  const d = { fs: { '/': { t: 'd' }, '/docs': { t: 'd' }, '/docs/a.txt': { t: 'f', c: 'hello legacy' }, '/b.txt': { t: 'f', content: 'bee' } }, j: [{ n: 0, op: 'x', h: 'y' }], notes: [{ text: 'note one' }, 'note two'], settings: { theme: 'light' } };
  const st = sha(JSON.stringify({ files: Object.keys(d.fs).sort().map((k) => [k, d.fs[k].t, rf(d.fs[k])]), notes: d.notes, settings: d.settings }));
  const r = { n: 0, timestamp: '2026-01-01T00:00:00.000Z', action: 'journal.initialized', details: { a: 1 }, state: st, previousHash: GEN };
  r.hash = sha(JSON.stringify({ n: r.n, timestamp: r.timestamp, action: r.action, details: r.details, state: r.state, previousHash: r.previousHash }));
  d.cx_journal_v1 = [r];
  if (tamper) d.fs['/b.txt'].content = 'changed after journal';
  return d;
}

(async () => {
  if (REMOTE) URL_ = REMOTE; else { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); URL_ = 'http://127.0.0.1:' + srv.address().port + (process.env.PREFIX || '/'); }
  console.log('Testing ' + URL_ + ' in ' + BROWSER + (LEGACY ? ' | legacy v0.9 file: ' + path.relative(path.join(__dirname, '..'), LEGACY) : ' | NO legacy file'));
  browser = await BT.launch();

  await test('1. Loads without a blank screen or console errors', async () => {
    const p = await newPage();
    check((await p.$$('.win')).length >= 2, 'default windows open');
    check(await p.textContent('#ws-name') === 'My Workspace', 'default workspace');
    await waitText(p, '#chip-journal', /Journal \d+/);
    check(p.errors.length === 0, 'console errors: ' + p.errors.join('|'));
    await p.context().close();
  });

  await test('2. Workspaces: create, switch, rename, independent data, delete with confirmation', async () => {
    const p = await newPage();
    await newFileUI(p, 'only-in-first.txt'); await p.waitForFunction(() => CX.shell.ws().exists('/only-in-first.txt'));
    await ev(p, () => CX.shell.openApp('workspaces')); await p.click(win('workspaces') + ' button:has-text("New workspace")'); await dlgFill(p, 'Second');
    await p.waitForFunction(() => document.getElementById('ws-name').textContent === 'Second');
    check(!(await files(p)).includes('/only-in-first.txt/') && !(await files(p)).includes('/only-in-first.txt'), 'workspaces are independent');
    await p.click('#ws-switch'); await p.waitForSelector(win('workspaces'));
    await p.click(win('workspaces') + ' .ws-item.current button:has-text("Rename")'); await dlgFill(p, 'Second renamed');
    await p.waitForFunction(() => document.getElementById('ws-name').textContent === 'Second renamed');
    // delete requires typing the name
    await p.click(win('workspaces') + ' .ws-item:not(.current) button:has-text("Delete")');
    check(await p.isDisabled('dialog.dlg .dlg-actions button:last-child'), 'delete disabled until name typed');
    await p.fill('dialog.dlg input', 'wrong'); check(await p.isDisabled('dialog.dlg .dlg-actions button:last-child'), 'wrong text keeps it disabled');
    await p.click('dialog.dlg .dlg-actions button:first-child'); await p.waitForSelector('dialog.dlg', { state: 'detached' });
    check((await ev(p, () => CX.store.listWorkspaces())).length === 2, 'cancel deletes nothing');
    await p.click(win('workspaces') + ' .ws-item:not(.current) button:has-text("Delete")'); await p.fill('dialog.dlg input', 'My Workspace'); await dlgOk(p);
    await p.waitForFunction(() => CX.store.listWorkspaces().then((l) => l.length === 1)).catch(() => {});
    await p.waitForTimeout(300);
    check((await ev(p, () => CX.store.listWorkspaces())).length === 1, 'deleted after confirmation');
    const orphan = await ev(p, async () => (await CX.idb.getAll('entries')).filter((e) => e.ws !== CX.shell.ws().id).length);
    check(orphan === 0, 'no orphaned entries after delete');
    await p.context().close();
  });

  await test('3 + 4. Create and edit a file; contents survive reload', async () => {
    const p = await newPage();
    await newFileUI(p, 'persist.txt');
    await p.waitForSelector(win('editor') + ' textarea:visible');
    await p.fill(win('editor') + ' textarea', 'line one\nline two ✓ unicode');
    await p.press(win('editor') + ' textarea', 'Control+s');
    await p.waitForFunction(() => CX.shell.ws().stat('/persist.txt').size > 0);
    await p.waitForTimeout(450); // layout state is saved ~0.25s after a change; file content is saved at once on Save
    await boot(p); // reload
    check(await read(p, '/persist.txt') === 'line one\nline two ✓ unicode', 'content after reload');
    check(await p.$(win('editor') + ' .tab') !== null, 'editor tab restored after reload');
    check(await p.inputValue(win('editor') + ' textarea') === 'line one\nline two ✓ unicode', 'editor shows content after reload');
    check(p.errors.length === 0, 'errors: ' + p.errors.join('|'));
    await p.context().close();
  });

  await test('5. Folder holds multiple files; rename and recursive delete; search', async () => {
    const p = await newPage();
    await openApp(p, 'files');
    await p.click(win('files') + ' button:has-text("New folder")'); await dlgFill(p, 'proj');
    await p.dblclick(win('files') + ' .row:has-text("proj")');
    for (const n of ['a.txt', 'b.txt', 'c.txt']) { await p.click(win('files') + ' button:has-text("New file")'); await dlgFill(p, n); await p.waitForFunction((x) => CX.shell.ws().exists('/proj/' + x), n); }
    await ev(p, async () => { await CX.shell.ws().writeFile('/proj/b.txt', 'needle in haystack'); });
    check((await p.$$(win('files') + ' .row')).length === 3, 'three rows in folder');
    check((await files(p)).filter((f) => f.startsWith('/proj/') && f !== '/proj/').length === 3, 'three files stored');
    const s1 = await ev(p, () => CX.shell.ws().search('needle'));
    check(s1.results.some((r) => r.path === '/proj/b.txt' && r.kind === 'content' && r.line === 1), 'content search finds line');
    check((await ev(p, () => CX.shell.ws().search('c.tx', { content: false }))).results.some((r) => r.path === '/proj/c.txt'), 'name search');
    await p.click(win('files') + ' .crumbs button:has-text("/")'); await p.click(win('files') + ' .row:has-text("proj")');
    await p.click(win('files') + ' button:has-text("Rename")'); await dlgFill(p, 'project');
    await p.waitForFunction(() => CX.shell.ws().exists('/project/b.txt'));
    check(!(await files(p)).some((f) => f.startsWith('/proj/')), 'old paths gone after folder rename');
    check(await read(p, '/project/b.txt') === 'needle in haystack', 'content preserved through rename');
    await p.click(win('files') + ' button:has-text("Delete")'); await dlgOk(p);
    await p.waitForFunction(() => !CX.shell.ws().exists('/project'));
    check(!(await files(p)).some((f) => f.startsWith('/project')), 'recursive delete');
    const bad = await ev(p, async () => { try { await CX.shell.ws().createFile('/x/y.txt', ''); return 'no error'; } catch (e) { return e.code; } });
    check(bad === 'E_NO_PARENT', 'creating under a missing folder is rejected: ' + bad);
    const dup = await ev(p, async () => { try { await CX.shell.ws().createFile('/README.md', ''); return 'no error'; } catch (e) { return e.code; } });
    check(dup === 'E_EXISTS', 'duplicate rejected');
    const evil = await ev(p, async () => { const out = []; for (const n of ['/a/../b', '/a//b', '/a/', 'rel', '/.', '/..']) { try { await CX.shell.ws().createFile(n, ''); out.push('accepted ' + n); } catch (e) { out.push(e.code); } } return out; });
    check(evil.every((x) => x.startsWith('E_')), 'invalid paths rejected: ' + evil.join(','));
    const big = await ev(p, async () => { try { await CX.shell.ws().createFile('/big.txt', 'x'.repeat(5 * 1024 * 1024 + 1)); return 'no error'; } catch (e) { return e.code; } });
    check(big === 'E_TOO_LARGE' && !(await files(p)).includes('/big.txt'), 'oversize file rejected without partial write: ' + big);
    await p.context().close();
  });

  await test('6 + 7. Snapshot create/restore; journal persists, verifies and records events', async () => {
    const p = await newPage();
    await ev(p, async () => { const w = CX.shell.ws(); await w.createDir('/d'); await w.createFile('/d/one.txt', 'v1'); await w.createFile('/two.txt', 'keep'); });
    await openApp(p, 'snapshots');
    await p.fill(win('snapshots') + ' input', 'before changes'); await p.click(win('snapshots') + ' button:has-text("Create snapshot")');
    await p.waitForSelector(win('snapshots') + ' .ws-item:has-text("before changes")');
    await ev(p, async () => { const w = CX.shell.ws(); await w.writeFile('/d/one.txt', 'v2 changed'); await w.remove('/two.txt'); await w.createFile('/new.txt', 'added later'); await w.rename('/d', '/moved'); });
    await p.click(win('snapshots') + ' .ws-item:has-text("before changes") button:has-text("Restore")'); await dlgOk(p);
    await p.waitForFunction(() => CX.shell.ws().exists('/two.txt') && !CX.shell.ws().exists('/new.txt'));
    check((await files(p)).join() === ['/README.md', '/d/', '/d/one.txt', '/two.txt'].sort().join(), 'files exactly match snapshot: ' + (await files(p)).join());
    check(await read(p, '/d/one.txt') === 'v1', 'old content restored');
    const snaps = await ev(p, () => CX.shell.ws().listSnapshots());
    check(snaps.length === 2 && snaps.some((s) => s.auto), 'automatic safety snapshot taken before restore');
    const safety = snaps.find((s) => s.auto);
    await ev(p, (id) => CX.shell.ws().restoreSnapshot(id), safety.id);
    check(await ev(p, () => CX.shell.ws().exists('/new.txt')), 'restore is undoable via safety snapshot');
    const types = (await ev(p, () => CX.shell.ws().readJournal())).map((r) => r.type);
    for (const t of ['workspace.created', 'file.created', 'folder.created', 'file.updated', 'file.deleted', 'entry.renamed', 'snapshot.created', 'snapshot.restored']) check(types.includes(t), 'journal has ' + t);
    check((await journalOk(p)).valid, 'journal verifies');
    const n = (await ev(p, () => CX.shell.ws().readJournal())).length;
    await boot(p);
    check((await ev(p, () => CX.shell.ws().readJournal())).length === n, 'journal entries persist across reload');
    check((await journalOk(p)).valid, 'journal verifies after reload');
    await waitText(p, '#chip-journal', /Journal \d+/);
    await p.context().close();
  });

  await test('7b. Journal detects tampering (edit, delete, reorder, outside change)', async () => {
    const p = await newPage();
    await ev(p, async () => { const w = CX.shell.ws(); for (let i = 0; i < 4; i++) await w.createFile('/f' + i + '.txt', 'x' + i); });
    const tamper = (fn) => ev(p, async (src) => { const f = new Function('s', 'return (' + src + ')(s)'); await CX.idb.tx('journal', 'readwrite', async (s) => { await f(s.journal); }); }, fn.toString());
    const id = await ev(p, () => CX.shell.ws().id);
    // edit data of record 2
    await ev(p, async (id) => { await CX.idb.tx('journal', 'readwrite', async (s) => { const r = await CX.idb.req(s.journal.get([id, 2])); r.data = { path: '/evil' }; s.journal.put(r); }); }, id);
    let v = await journalOk(p); check(!v.valid && v.issues.some((i) => /Record 2 data/.test(i)), 'edited data detected: ' + v.issues.join('|'));
    // restore then delete record 2
    await ev(p, async (id) => { await CX.idb.tx('journal', 'readwrite', async (s) => { const r = await CX.idb.req(s.journal.get([id, 2])); r.data = { path: '/f1.txt', size: 2, hash: r.data.hash }; s.journal.put(r); }); }, id);
    await ev(p, async (id) => { await CX.idb.tx('journal', 'readwrite', async (s) => { s.journal.delete([id, 2]); }); }, id);
    v = await journalOk(p); check(!v.valid && v.issues.some((i) => /gap|Sequence/.test(i)), 'deleted record detected: ' + v.issues.join('|'));
    await p.context().close();
    const p2 = await newPage();
    await ev(p2, async () => { await CX.shell.ws().createFile('/a.txt', 'a'); });
    await ev(p2, async () => { const id = CX.shell.ws().id; await CX.idb.tx('entries', 'readwrite', async (s) => { s.entries.delete([id, '/a.txt']); }); });
    const v2 = await journalOk(p2); check(!v2.valid && v2.issues.some((i) => /do not match the last journal record/.test(i)), 'out-of-band file removal detected: ' + v2.issues.join('|'));
    await p2.context().close();
    const p3 = await newPage();
    await ev(p3, async () => { await CX.shell.ws().createFile('/a.txt', 'a'); });
    await ev(p3, async () => { const h = CX.shell.ws().stat('/a.txt').hash; await CX.idb.tx('blobs', 'readwrite', async (s) => { s.blobs.delete(h); }); });
    const v3 = await journalOk(p3); check(!v3.valid && v3.issues.some((i) => /missing from storage/.test(i)), 'missing stored content detected: ' + v3.issues.join('|'));
    const rd = await ev(p3, async () => { try { await CX.shell.ws().read('/a.txt'); return 'read ok'; } catch (e) { return e.code; } });
    check(rd === 'E_CORRUPT', 'reading corrupt file fails loudly, not silently: ' + rd);
    await p3.context().close();
  });

  await test('8. Export and re-import a workspace (round trip)', async () => {
    const p = await newPage();
    await ev(p, async () => { const w = CX.shell.ws(); await w.createDir('/src'); await w.createFile('/src/main.js', 'console.log("héllo ✓")'); await w.createFile('/notes.txt', 'n'); await w.createSnapshot('snap in export'); await w.writeFile('/notes.txt', 'n2'); });
    await openApp(p, 'workspaces');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click(win('workspaces') + ' button:has-text("Export current")')]);
    const file = '/tmp/cx-export.cxpkg.json'; await dl.saveAs(file);
    check(/\.cxpkg\.json$/.test(dl.suggestedFilename()), 'filename: ' + dl.suggestedFilename());
    const before = await ev(p, async () => ({ files: CX.shell.ws().all().map((e) => e.path).sort(), head: CX.shell.ws().rec.headHash }));
    await p.setInputFiles(win('workspaces') + ' input[type=file]', file); await p.waitForSelector('dialog.dlg'); await dlgOk(p);
    await p.waitForFunction(() => CX.store.listWorkspaces().then((l) => l.length === 2));
    await p.waitForTimeout(200);
    const imported = await ev(p, async () => { const l = await CX.store.listWorkspaces(); const w = await CX.store.open(l.find((x) => x.id !== CX.shell.ws().id).id); const v = await w.verify(); const types = (await w.readJournal()).map((r) => r.type);
      return { name: w.name, files: w.all().map((e) => e.path).sort(), main: await w.read('/src/main.js'), notes: await w.read('/notes.txt'), snaps: (await w.listSnapshots()).length, valid: v.valid, issues: v.issues, last: types[types.length - 1], count: types.length }; });
    check(imported.name === 'My Workspace (imported)', 'name collision handled: ' + imported.name);
    check(imported.files.join() === before.files.join(), 'same structure');
    check(imported.main === 'console.log("héllo ✓")' && imported.notes === 'n2', 'same content');
    check(imported.snaps === 1, 'snapshots preserved');
    check(imported.valid, 'imported workspace journal verifies: ' + imported.issues.join('|'));
    check(imported.last === 'workspace.imported', 'import recorded in journal');
    // importing the same package again must not collide with or alter the first import
    await p.setInputFiles(win('workspaces') + ' input[type=file]', file); await p.waitForSelector('dialog.dlg'); await dlgOk(p);
    await p.waitForFunction(() => CX.store.listWorkspaces().then((l) => l.length === 3)); await p.waitForTimeout(200);
    const snapsAll = await ev(p, async () => (await CX.idb.getAll('snapshots')).map((s) => s.ws + '|' + s.id));
    check(new Set(snapsAll).size === snapsAll.length && snapsAll.length === 3, 'every import keeps its own snapshot record (original + 2 imports): ' + snapsAll.length);
    await p.context().close();
  });

  await test('9. Invalid imports are rejected and change nothing', async () => {
    const p = await newPage();
    await ev(p, async () => { await CX.shell.ws().createFile('/keep.txt', 'important'); });
    const exported = await ev(p, async () => JSON.stringify(await CX.pkg.build(CX.shell.ws())));
    const base = JSON.parse(exported);
    const reseal = (o) => { const { packageHash, ...rest } = o; const canon = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'); o.packageHash = 'sha256:' + sha(canon(rest)); return o; };
    const clone = () => JSON.parse(exported);
    const cases = {
      'not json': 'this is not json {',
      'json array': '[1,2,3]',
      'wrong spec': JSON.stringify({ spec: 'something/else' }),
      'v0.9 lookalike without root': JSON.stringify({ fs: { '/a': { t: 'f' } } }),
      'edited without resealing': (() => { const o = clone(); o.blobs[Object.keys(o.blobs)[0]] = 'tampered'; return JSON.stringify(o); })(),
      'resealed with changed content': (() => { const o = clone(); o.blobs[Object.keys(o.blobs)[0]] = 'tampered'; return JSON.stringify(reseal(o)); })(),
      'resealed with bad path': (() => { const o = clone(); o.entries.push({ path: '/../etc', type: 'file', hash: o.entries[0].hash, size: 1, ctime: 1, mtime: 1, rev: 1 }); return JSON.stringify(reseal(o)); })(),
      'resealed with renamed entry': (() => { const o = clone(); o.entries[0].path = '/renamed.md'; return JSON.stringify(reseal(o)); })(),
      'resealed with journal edit': (() => { const o = clone(); o.journal[1].data = { path: '/x' }; return JSON.stringify(reseal(o)); })(),
      'resealed with truncated journal': (() => { const o = clone(); o.journal.pop(); return JSON.stringify(reseal(o)); })(),
      'resealed missing blob': (() => { const o = clone(); delete o.blobs[Object.keys(o.blobs)[0]]; return JSON.stringify(reseal(o)); })(),
      'resealed with huge name': (() => { const o = clone(); o.workspace.name = 'x'.repeat(500); return JSON.stringify(reseal(o)); })(),
    };
    await openApp(p, 'workspaces');
    const out = [];
    for (const [name, body] of Object.entries(cases)) {
      fs.writeFileSync('/tmp/bad.json', body);
      await p.setInputFiles(win('workspaces') + ' input[type=file]', '/tmp/bad.json');
      await p.waitForSelector('dialog.dlg'); const title = await p.textContent('dialog.dlg h2');
      await p.click('dialog.dlg .dlg-actions button:last-child'); await p.waitForSelector('dialog.dlg', { state: 'detached' });
      const n = (await ev(p, () => CX.store.listWorkspaces())).length;
      out.push(name + ': ' + title + ' / ' + n + ' ws');
      check(/rejected/i.test(title), name + ' was not rejected (' + title + ')');
      check(n === 1, name + ' changed the workspace count');
    }
    check(await read(p, '/keep.txt') === 'important', 'existing data untouched');
    check((await journalOk(p)).valid, 'existing journal still valid');
    fs.writeFileSync('/tmp/results-invalid.txt', out.join('\n'));
    // valid package still imports (control)
    fs.writeFileSync('/tmp/good.json', exported); await p.setInputFiles(win('workspaces') + ' input[type=file]', '/tmp/good.json'); await p.waitForSelector('dialog.dlg');
    check(/Import/.test(await p.textContent('dialog.dlg h2')) && !/rejected/i.test(await p.textContent('dialog.dlg h2')), 'control: valid package accepted');
    await p.context().close();
  });

  await (BROWSER === 'firefox' ? Promise.resolve(skip('10. Mobile layout is usable', 'Playwright cannot emulate mobile in Firefox')) : test('10. Mobile layout is usable', async () => {
    const p = await newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const vis = () => p.$$eval('.win', (e) => e.filter((x) => x.offsetParent !== null).map((x) => x.dataset.app));
    check((await vis()).join() === 'files', 'one full-screen app at a time: ' + (await vis()).join());
    check(await ev(p, () => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page overflow');
    const offscreen = () => p.$$eval('#topbar button, #topbar .chip, .win.active .win-title button, .win.active .toolbar button, #dock .dock-btn:nth-child(-n+5)', (els) => els.filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 18), right: Math.round(r.right), left: Math.round(r.left) }; }).filter((x) => x.right > window.innerWidth + 1 || x.left < -1));
    check((await offscreen()).length === 0, 'controls pushed outside the screen: ' + JSON.stringify(await offscreen()));
    check(await p.isVisible('#btn-palette') && await p.isVisible('#btn-theme') && await p.isVisible(win('files') + ' [data-act="close"]'), 'palette, theme and close buttons are reachable');
    const dock = await p.$eval('#dock', (e) => { const r = e.getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }; });
    check(dock.top > 600, 'dock is at the bottom: ' + dock.top);
    await p.tap(win('files') + ' button:has-text("New file")'); await dlgFill(p, 'phone.txt');
    await p.waitForSelector(win('editor') + ' textarea:visible');
    check((await vis()).join() === 'editor', 'editor opened full screen: ' + (await vis()).join());
    await p.fill(win('editor') + ' textarea', 'typed on phone'); await p.tap(win('editor') + ' button:has-text("Save")');
    await p.waitForFunction(() => CX.shell.ws().stat('/phone.txt').size === 14);
    check((await offscreen()).length === 0, 'editor screen controls on screen: ' + JSON.stringify(await offscreen()));
    await p.tap('.dock-btn[data-app="snapshots"]'); check((await vis()).join() === 'snapshots', 'dock switches app');
    const small = await p.$$eval('button, input, select, .dock-btn', (els) => els.filter((e) => e.offsetParent !== null && !e.closest('.win:not(.active)')).map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 20), h: Math.round(r.height), w: Math.round(r.width) }; }).filter((x) => x.h < 40 && !/^$/.test(x.n)));
    check(small.length === 0, 'touch targets under 40px: ' + JSON.stringify(small.slice(0, 5)));
    await p.tap('.dock-btn[data-app="files"]'); await p.screenshot({ path: '/tmp/mobile-files.png' });
    await p.tap('.dock-btn[data-app="editor"]'); await p.screenshot({ path: '/tmp/mobile-editor.png' });
    check(p.errors.length === 0, 'errors: ' + p.errors.join('|'));
    await p.context().close();
  }));

  await test('11. Manifest: validate, unsupported features, unknown fields, rejection of bad imports', async () => {
    const p = await newPage();
    await openApp(p, 'manifest'); await p.click(win('manifest') + ' button:has-text("Create from template")');
    await p.waitForFunction(() => CX.shell.ws().exists('/cx.workspace.json'));
    await waitText(p, win('manifest') + ' .badge', /VALID/);
    const rich = { spec: 'cx.workspace/0.1', id: 'ws_demo', name: 'Demo', revision: 3, futureThing: { keep: 'me' }, strictness: 'floating',
      components: [{ id: 'node', kind: 'runtime', source: { type: 'oci', ref: 'example.org/node:20' }, continuity: { level: 'C1', state: { strategy: 'files', paths: ['/'] } }, needs: { cpu: 2, gpu: 'a100' } }],
      burst: { mode: 'auto-within-grant', maxPerJobMicroUsd: '0' }, authority: { requests: [{ act: ['read'], res: 'cx:ws/self/fs/**' }] }, secrets: [{ name: 'T', ref: 'cx-secret:t', delivery: 'env' }] };
    const r = await ev(p, async (t) => CX.manifest.validate(t), JSON.stringify(rich));
    check(r.ok, 'rich manifest valid: ' + JSON.stringify(r.errors));
    const feats = r.unsupported.map((u) => u.feature).join('|');
    check(/Remote burst/.test(feats) && /GPU/.test(feats) && /Capability/.test(feats) && /Secret/.test(feats) && /Fetching/.test(feats), 'unsupported features reported: ' + feats);
    check(r.unknown.includes('futureThing'), 'unknown field identified');
    const bad = async (m) => ev(p, async (t) => (await CX.manifest.validate(t)).errors.map((e) => e.code + ':' + e.path), JSON.stringify(m));
    check((await bad({ spec: 'cx.workspace/9.9', id: 'x', name: 'n', revision: 1 })).join().includes('E_SPEC'), 'wrong version');
    check((await bad({ ...rich, strictness: 'pinned' })).join().includes('E_UNPINNED'), 'unpinned under pinned strictness');
    check((await bad({ spec: 'cx.workspace/0.1', id: 'x', name: 'n', revision: 1, components: [{ id: 'a', kind: 'runtime', source: { type: 'files', paths: ['/'] }, continuity: { level: 'C3' } }] })).join().includes('E_LEVEL'), 'C3 rejected');
    check((await bad({ spec: 'cx.workspace/0.1', id: 'x', name: 'n', revision: 1, secrets: [{ name: 'a', ref: 'r', value: 'hunter2' }] })).join().includes('E_SECRET_VALUE'), 'secret value rejected');
    check((await bad({ spec: 'cx.workspace/0.1', id: 'x', name: 'n', revision: 1, grants: [] })).join().includes('E_FORBIDDEN'), 'grants rejected');
    check((await ev(p, async () => (await CX.manifest.validate('{ nope')).errors[0].code)) === 'E_JSON', 'syntax error reported');
    // import: invalid rejected with nothing changed, valid accepted with unknown fields preserved byte for byte
    const before = await read(p, '/cx.workspace.json'), revBefore = await ev(p, () => CX.shell.ws().stat('/cx.workspace.json').rev);
    fs.writeFileSync('/tmp/m-bad.json', JSON.stringify({ spec: 'cx.workspace/0.1', name: 5 }));
    await p.setInputFiles(win('manifest') + ' input[type=file]', '/tmp/m-bad.json'); await p.waitForSelector('dialog.dlg'); check(/rejected/i.test(await p.textContent('dialog.dlg h2')), 'bad import rejected');
    await p.click('dialog.dlg .dlg-actions button:last-child'); await p.waitForSelector('dialog.dlg', { state: 'detached' });
    check(await read(p, '/cx.workspace.json') === before, 'manifest unchanged after rejected import');
    const text = JSON.stringify(rich, null, 3); fs.writeFileSync('/tmp/m-good.json', text);
    await p.setInputFiles(win('manifest') + ' input[type=file]', '/tmp/m-good.json'); await p.waitForSelector('dialog.dlg'); await dlgOk(p);
    await p.waitForFunction((r) => CX.shell.ws().stat('/cx.workspace.json').rev > r, revBefore);
    check(await read(p, '/cx.workspace.json') === text, 'unknown fields preserved exactly');
    check((await ev(p, async () => (await CX.shell.ws().readJournal()).map((r) => r.type))).includes('manifest.updated'), 'manifest.updated journaled');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click(win('manifest') + ' button:has-text("Export")')]);
    await dl.saveAs('/tmp/m-out.json'); check(fs.readFileSync('/tmp/m-out.json', 'utf8') === text, 'export equals saved manifest');
    // save blocked while invalid
    await p.fill(win('manifest') + ' textarea', '{"spec":"cx.workspace/0.1"}'); await p.waitForTimeout(450);
    check(await p.isDisabled(win('manifest') + ' button:has-text("Save")'), 'Save disabled while invalid');
    await p.screenshot({ path: '/tmp/manifest.png' });
    await p.context().close();
  });

  await test('12. v0.9 data is found, verified and imported without touching the original', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage();
    await blockFonts(p);
    const good = JSON.stringify(v09Fixture(false)), bad = JSON.stringify(v09Fixture(true));
    await p.addInitScript((g) => { if (!localStorage.getItem('cx') && !sessionStorage.getItem('seeded')) { localStorage.setItem('cx', g); sessionStorage.setItem('seeded', '1'); } }, good);
    await boot(p); await openApp(p, 'workspaces');
    await p.waitForSelector(win('workspaces') + ' .card:has-text("v0.9 data found")');
    await p.click(win('workspaces') + ' button:has-text("Import v0.9 data")'); await dlgOk(p);
    await p.waitForSelector('dialog.dlg:has-text("v0.9 data imported")'); const msg = await p.textContent('dialog.dlg');
    check(/verified \(1 records\)/.test(msg), 'v0.9 chain verified: ' + msg.slice(0, 120));
    await p.click('dialog.dlg .dlg-actions button:last-child');
    await p.waitForFunction(() => CX.store.listWorkspaces().then((l) => l.length === 2)); await p.waitForTimeout(200);
    const r = await ev(p, async () => { const l = await CX.store.listWorkspaces(); const w = await CX.store.open(l.find((x) => x.name === 'Imported from v0.9').id);
      return { files: w.all().map((e) => e.path).sort(), a: await w.read('/docs/a.txt'), b: await w.read('/b.txt'), n1: await w.read('/Notes/note-1.txt'), n2: await w.read('/Notes/note-2.txt'), legacy: JSON.parse(await w.read('/.cx/legacy/journal-v1.json')).length, v: (await w.verify()).valid, types: (await w.readJournal()).map((x) => x.type) }; });
    check(r.a === 'hello legacy' && r.b === 'bee' && r.n1 === 'note one' && r.n2 === 'note two', 'content migrated');
    check(r.legacy === 1 && r.types.includes('log.bridged-from-v0.9') && r.v, 'legacy chain preserved and bridged; new journal valid');
    check(await ev(p, (g) => localStorage.getItem('cx') === g, good), 'original v0.9 localStorage untouched');
    await boot(p); await openApp(p, 'workspaces'); await p.waitForTimeout(400);
    check((await p.$$(win('workspaces') + ' .card:has-text("v0.9 data found")')).length === 0, 'banner not offered again after import');
    // tampered v0.9 data: still imports, but is reported as not verified
    await p.evaluate((b) => { localStorage.setItem('cx', b); }, bad); await boot(p); await openApp(p, 'workspaces');
    await p.click(win('workspaces') + ' button:has-text("Import v0.9 data")'); await dlgOk(p);
    await p.waitForSelector('dialog.dlg:has-text("v0.9 data imported")'); check(/did NOT verify/.test(await p.textContent('dialog.dlg')), 'tampered v0.9 chain flagged');
    await ctx.close();
  });

  await test('13. Interrupted write is recovered; nothing half-applied', async () => {
    const p = await newPage();
    await ev(p, async () => { await CX.shell.ws().createFile('/safe.txt', 'safe'); });
    const before = await ev(p, () => ({ head: CX.shell.ws().rec.headSeq, files: CX.shell.ws().all().length }));
    await ev(p, async () => { await CX.idb.put('intents', { id: 'int_crash', ws: CX.shell.ws().id, type: 'file.created', created: new Date().toISOString(), state: 'pending' }); });
    await boot(p);
    const after = await ev(p, async () => ({ types: (await CX.shell.ws().readJournal()).map((r) => r.type), intents: (await CX.idb.getAll('intents')).length, files: CX.shell.ws().all().length, rec: CX.store.recovery() }));
    check(after.intents === 0, 'stale intent cleared');
    check(after.types[after.types.length - 1] === 'recovery.intent-discarded', 'recovery recorded in journal');
    check(after.files === before.files, 'file set unchanged');
    check((await journalOk(p)).valid, 'journal valid after recovery');
    // failure inside the apply transaction leaves no partial state
    const r = await ev(p, async () => { const w = CX.shell.ws(); const head = w.rec.headSeq; const orig = IDBObjectStore.prototype.put; let n = 0;
      IDBObjectStore.prototype.put = function (v) { if (this.name === 'journal') { IDBObjectStore.prototype.put = orig; throw new DOMException('injected', 'DataError'); } return orig.apply(this, arguments); };
      let code; try { await w.createFile('/halfway.txt', 'x'); code = 'no error'; } catch (e) { code = e.code; } IDBObjectStore.prototype.put = orig;
      return { code, exists: w.exists('/halfway.txt'), blob: (await CX.idb.getAll('blobs')).some((b) => b.content === 'x'), head: (await CX.store.open(w.id)).rec.headSeq === head, intents: (await CX.idb.getAll('intents')).length, valid: (await w.verify()).valid, ents: (await CX.idb.getAll('entries')).filter((e) => e.path === '/halfway.txt').length }; });
    check(r.code !== 'no error' && !r.exists && !r.blob && r.head && r.ents === 0 && r.valid && r.intents === 0, 'injected failure rolled back completely: ' + JSON.stringify(r));
    await p.context().close();
  });

  await test('14. Two tabs writing at once keep one valid, gap-free journal', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const mk = async () => { const p = await ctx.newPage(); await blockFonts(p); await boot(p); return p; };
    const a = await mk(); const b = await mk();
    await ev(a, async () => { await CX.shell.ws().createFile('/seed.txt', 's'); });
    const idB = await ev(b, () => CX.shell.ws().id), idA = await ev(a, () => CX.shell.ws().id);
    check(idA === idB, 'both tabs on the same workspace');
    const burst = (p, tag) => ev(p, async (t) => { const out = []; await Promise.all(Array.from({ length: 8 }, (_, i) => CX.shell.ws().createFile('/' + t + i + '.txt', t + i).then(() => out.push('ok'), (e) => out.push(e.code)))); return out; }, tag);
    const [ra, rb] = await Promise.all([burst(a, 'a'), burst(b, 'b')]);
    const okCount = [...ra, ...rb].filter((x) => x === 'ok').length;
    check(okCount === 16, 'all 16 writes succeeded: ' + [...ra, ...rb].filter((x) => x !== 'ok').join(','));
    const v = await ev(a, async () => { const w = await CX.store.open(CX.shell.ws().id); return { v: await w.verify(), n: w.all().length }; });
    check(v.v.valid && v.n === 18 && v.v.count >= 18, 'journal valid and complete: ' + JSON.stringify({ n: v.n, c: v.v.count, i: v.v.issues }));
    await ctx.close();
  });

  await test('14b. A tab saving its layout while another tab writes cannot corrupt the journal', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const mk = async () => { const p = await ctx.newPage(); await blockFonts(p); await boot(p); return p; };
    const a = await mk(); const b = await mk();
    await ev(a, async () => { await CX.shell.ws().createFile('/from-a.txt', 'a'); });          // tab A writes
    await ev(b, async () => { await CX.shell.ws().saveUi({ windows: [], apps: {} }); });        // tab B saves layout (does not know about A's write yet)
    await ev(b, async () => { await CX.shell.ws().createFile('/from-b.txt', 'b'); });          // tab B then writes
    const r = await ev(a, async () => { const w = await CX.store.open(CX.shell.ws().id); const v = await w.verify(); return { valid: v.valid, issues: v.issues, files: w.all().map((e) => e.path).sort() }; });
    check(r.valid && r.files.includes('/from-a.txt') && r.files.includes('/from-b.txt'), 'journal stays consistent: ' + JSON.stringify(r));
    await ctx.close();
  });

  await test('14c. A second open tab shows changes live; unsaved text is protected; a workspace deleted in one tab moves the other tab to a valid one', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const mk = async () => { const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) p.errors.push(m.text()); }); await blockFonts(p); await boot(p); return p; };
    const a = await mk(); const b = await mk();
    await openApp(b, 'files');
    await ev(a, async () => { await CX.shell.ws().createFile('/appears-in-b.txt', 'hi'); });
    await b.waitForSelector(win('files') + ' .row:has-text("appears-in-b.txt")', { timeout: 4000 });
    await ev(b, () => CX.shell.openApp('editor', { path: '/appears-in-b.txt' })); await b.waitForSelector(win('editor') + ' .tab:has-text("appears-in-b.txt")');
    await b.fill(win('editor') + ' textarea', 'unsaved in b');
    await ev(a, async () => { await CX.shell.ws().createFile('/another.txt', 'x'); }); await b.waitForSelector(win('files') + ' .row:has-text("another.txt")', { timeout: 4000 });
    check(await b.inputValue(win('editor') + ' textarea') === 'unsaved in b', 'unsaved edit survives changes made in another tab');
    const tempId = await ev(a, async () => (await CX.store.createWorkspace('Temp')).id);
    // switching away with unsaved text must ask, and cancelling must keep the text
    const sw = ev(b, async (id) => { await CX.shell.switchWorkspace(id); }, tempId);
    await b.waitForSelector('dialog.dlg:has-text("unsaved")'); await b.click('dialog.dlg .dlg-actions button:first-child'); await b.waitForSelector('dialog.dlg', { state: 'detached' }); await sw;
    check(await ev(b, () => CX.shell.ws().name) === 'My Workspace' && await b.inputValue(win('editor') + ' textarea') === 'unsaved in b', 'cancelling keeps the edit and the workspace');
    await b.click(win('editor') + ' button:has-text("Save")'); await b.waitForFunction(() => CX.shell.ws().stat('/appears-in-b.txt').size === 12);
    await ev(b, async (id) => { await CX.shell.switchWorkspace(id); }, tempId); await b.waitForFunction(() => CX.shell.ws().name === 'Temp');
    await ev(a, async (id) => { await CX.shell.switchWorkspace(id); }, tempId); await a.waitForFunction(() => CX.shell.ws().name === 'Temp');
    await ev(a, async (id) => { await CX.store.deleteWorkspace(id); await CX.shell.afterDelete(id); }, tempId);
    await b.waitForFunction((id) => CX.shell.ws() && CX.shell.ws().id !== id, tempId, { timeout: 6000 });
    check(await ev(b, async () => (await CX.shell.ws().verify()).valid), 'tab B landed on a valid workspace');
    check(b.errors.length === 0 && a.errors.length === 0, 'console errors: ' + a.errors.concat(b.errors).join('|'));
    await ctx.close();
  });

  await test('15. Keyboard: palette, file list keys, dialogs close with Escape', async () => {
    const p = await newPage();
    await ev(p, async () => { const w = CX.shell.ws(); await w.createFile('/a.txt', 'a'); await w.createFile('/b.txt', 'b'); });
    await p.keyboard.press('Control+k'); await p.waitForSelector('dialog.pal input');
    await p.keyboard.type('snapshot'); await p.keyboard.press('Enter');
    await p.waitForFunction(() => CX.shell.ws().listSnapshots().then((l) => l.length === 1));
    await p.keyboard.press('Control+k'); await p.waitForSelector('dialog.pal'); await p.keyboard.press('Escape'); await p.waitForSelector('dialog.pal', { state: 'detached' });
    await openApp(p, 'files'); await p.click(win('files') + ' .row:has-text("a.txt")'); await p.focus(win('files') + ' .list');
    await p.keyboard.press('ArrowDown'); check(await p.$eval(win('files') + ' .row[aria-selected="true"]', (e) => e.dataset.path) === '/b.txt', 'ArrowDown selects next');
    await p.keyboard.press('F2'); await p.waitForSelector('dialog.dlg input'); await p.keyboard.press('Escape'); await p.waitForSelector('dialog.dlg', { state: 'detached' });
    check(await ev(p, () => CX.shell.ws().exists('/b.txt')), 'Escape cancels rename');
    await p.focus(win('files') + ' .list'); await p.keyboard.press('Delete'); await p.waitForSelector('dialog.dlg'); await p.keyboard.press('Escape');
    check(await ev(p, () => CX.shell.ws().exists('/b.txt')), 'Escape cancels delete');
    await p.focus(win('files') + ' .list'); await p.keyboard.press('Enter'); await p.waitForSelector(win('editor') + ' .tab:has-text("b.txt")');
    await p.context().close();
  });

  await test('16. Window management and layout persistence; theme persistence', async () => {
    const p = await newPage();
    const box = (id) => p.$eval(win(id), (e) => ({ l: parseFloat(e.style.left), t: parseFloat(e.style.top), w: parseFloat(e.style.width), h: parseFloat(e.style.height) }));
    const b0 = await box('files');
    const rz = await p.$eval(win('files') + ' .resize', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 }; });
    await p.mouse.move(rz.x, rz.y); await p.mouse.down(); await p.mouse.move(rz.x - 40, rz.y - 30, { steps: 5 }); await p.mouse.up();
    const b1 = await box('files'); check(Math.abs(b1.w - (b0.w - 40)) < 3 && Math.abs(b1.h - (b0.h - 30)) < 3, 'resize works: ' + JSON.stringify([b0, b1]));
    const tb = await p.$eval(win('files') + ' .win-title', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 100, y: r.y + 15 }; });
    await p.mouse.move(tb.x, tb.y); await p.mouse.down(); await p.mouse.move(tb.x + 60, tb.y + 40, { steps: 5 }); await p.mouse.up();
    const b2 = await box('files'); check(Math.abs(b2.l - b1.l - 60) < 3 && Math.abs(b2.t - b1.t - 40) < 3, 'drag moves window');
    await p.click(win('files') + ' [data-act="min"]'); check(!(await p.isVisible(win('files'))), 'minimise hides');
    await p.click('.dock-btn[data-app="files"]'); check(await p.isVisible(win('files')), 'dock restores');
    await p.click(win('editor') + ' [data-act="max"]'); const m = await box('editor'); const dk = await p.$eval('#desktop', (e) => e.getBoundingClientRect().width);
    check(Math.abs(m.w - dk) < 2, 'maximise fills desktop');
    await p.click(win('editor') + ' [data-act="max"]');
    await p.click(win('editor') + ' [data-act="close"]'); check(!(await p.$(win('editor'))), 'close removes window');
    await p.waitForTimeout(600); await boot(p);
    const b3 = await box('files'); check(Math.abs(b3.l - b2.l) < 3 && Math.abs(b3.w - b2.w) < 3, 'layout restored after reload');
    check(!(await p.$(win('editor'))), 'closed window stays closed after reload');
    await p.click('#btn-theme'); await p.waitForFunction(() => CX.shell.ws().settings.theme !== 'system');
    const t = await ev(p, () => document.documentElement.dataset.theme); await boot(p);
    check(await ev(p, () => document.documentElement.dataset.theme) === t, 'theme persists per workspace: ' + t);
    await p.context().close();
  });

  await test('17. Upload: text accepted, binary and oversize rejected, nothing overwritten', async () => {
    const p = await newPage(); await openApp(p, 'files');
    fs.writeFileSync('/tmp/up-ok.txt', 'plain text ✓'); fs.writeFileSync('/tmp/up-bin.dat', Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]));
    await p.setInputFiles(win('files') + ' input[type=file]', ['/tmp/up-ok.txt', '/tmp/up-bin.dat']);
    await p.waitForSelector('dialog.dlg:has-text("not added")'); check(/not a text file/.test(await p.textContent('dialog.dlg')), 'binary rejected with reason');
    await p.click('dialog.dlg .dlg-actions button:last-child');
    check(await read(p, '/up-ok.txt') === 'plain text ✓' && !(await files(p)).includes('/up-bin.dat'), 'text kept, binary absent');
    await p.setInputFiles(win('files') + ' input[type=file]', '/tmp/up-ok.txt'); await p.waitForSelector('dialog.dlg:has-text("not added")'); check(/already exists/.test(await p.textContent('dialog.dlg')), 'no silent overwrite');
    await p.context().close();
  });

  await test('18. Editor never silently loses text (conflict, delete, discard)', async () => {
    const p = await newPage();
    await ev(p, async () => { await CX.shell.ws().createFile('/c.txt', 'orig'); }); await ev(p, () => CX.shell.openApp('editor', { path: '/c.txt' }));
    await p.waitForSelector(win('editor') + ' .tab:has-text("c.txt")');
    await p.fill(win('editor') + ' textarea', 'my edit');
    await ev(p, async () => { await CX.shell.ws().writeFile('/c.txt', 'other writer'); });   // changed elsewhere while dirty
    await p.waitForTimeout(150); check(/Changed elsewhere/.test(await p.textContent(win('editor') + ' .statusbar')), 'warns about outside change');
    check(await p.inputValue(win('editor') + ' textarea') === 'my edit', 'buffer kept');
    await p.click(win('editor') + ' button:has-text("Save")'); await p.waitForSelector('dialog.dlg:has-text("changed elsewhere")');
    await p.click('dialog.dlg .dlg-actions button:first-child'); await p.waitForSelector('dialog.dlg', { state: 'detached' });
    check(await read(p, '/c.txt') === 'other writer', 'declining overwrite keeps the other version');
    await ev(p, async () => { await CX.shell.ws().remove('/c.txt'); }); await p.waitForTimeout(150);
    check(/Deleted elsewhere/.test(await p.textContent(win('editor') + ' .statusbar')) && await p.inputValue(win('editor') + ' textarea') === 'my edit', 'deleted file keeps the buffer');
    await p.click(win('editor') + ' button:has-text("Save")'); await p.waitForSelector('dialog.dlg:has-text("Recreate")'); await dlgOk(p);
    await p.waitForFunction(() => CX.shell.ws().exists('/c.txt')); check(await read(p, '/c.txt') === 'my edit', 'recreate saves the text');
    await p.fill(win('editor') + ' textarea', 'unsaved'); await p.click(win('editor') + ' [data-act="close"]'); await p.waitForSelector('dialog.dlg:has-text("unsaved")');
    await p.click('dialog.dlg .dlg-actions button:first-child'); await p.waitForSelector('dialog.dlg', { state: 'detached' });
    check(!!(await p.$(win('editor'))), 'closing with unsaved text asks first and can be cancelled');
    await p.context().close();
  });

  await test('19. Accessibility basics: names, roles, contrast, reduced motion', async () => {
    const p = await newPage();
    for (const id of ['files', 'editor', 'search', 'snapshots', 'journal', 'manifest', 'terminal', 'monitor', 'workspaces', 'settings']) await openApp(p, id);
    const unnamed = await p.$$eval('button, input, select, textarea', (els) => els.filter((e) => e.offsetParent !== null || e.closest('.win')).filter((e) => e.type !== 'hidden' && !e.classList.contains('hidden')).filter((e) => { const n = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '').trim(); const lab = e.id && document.querySelector('label[for="' + e.id + '"]'); const wrap = e.closest('label'); return !n && !lab && !wrap; }).map((e) => e.outerHTML.slice(0, 80)));
    check(unnamed.length === 0, 'controls without accessible names: ' + unnamed.join(' | '));
    check(await p.$eval('#toasts', (e) => e.getAttribute('aria-live')) === 'polite', 'toast live region');
    const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    const L = (c) => { const [r, g, b] = hex(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const dark = { canvas: '#080A10', low: '#0E121F', mid: '#161C2E', high: '#1F273E', border: '#26304D', active: '#00E5FF', violet: '#7C4DFF', text: '#F8FAFC', t2: '#94A3B8' };
    const light = { canvas: '#F4F6F9', low: '#FFFFFF', mid: '#E9ECF2', high: '#D8DEE9', border: '#CBD5E1', active: '#007C8A', violet: '#6200EA', text: '#0F172A', t2: '#475569' };
    const rows = [];
    for (const [nm, t] of [['dark', dark], ['light', light]]) {
      const pairs = [['text on canvas', t.text, t.canvas, 4.5], ['text on surface low', t.text, t.low, 4.5], ['text on surface mid', t.text, t.mid, 4.5], ['text on surface high', t.text, t.high, 4.5],
        ['secondary on canvas', t.t2, t.canvas, 4.5], ['secondary on surface low', t.t2, t.low, 4.5], ['secondary on surface mid', t.t2, t.mid, 4.5], ['secondary on surface high', t.t2, t.high, 4.5],
        ['white on violet (buttons)', '#FFFFFF', t.violet, 4.5], ['focus ring on canvas', t.active, t.canvas, 3], ['focus ring on surface low', t.active, t.low, 3], ['focus ring on surface mid', t.active, t.mid, 3], ['active border on canvas', t.active, t.canvas, 3]];
      pairs.forEach(([n, a, b, min]) => rows.push({ theme: nm, n, ratio: +cr(a, b).toFixed(2), min, pass: cr(a, b) >= min }));
    }
    fs.writeFileSync('/tmp/contrast.json', JSON.stringify(rows, null, 1));
    const fails = rows.filter((r) => !r.pass); check(fails.length === 0, 'contrast failures: ' + JSON.stringify(fails));
    const a = await ev(p, () => { const d = document.createElement('i'); d.className = 'dot busy'; document.body.appendChild(d); const n = getComputedStyle(d).animationName; d.remove(); return n; });
    check(a !== 'none', 'busy dot animates by default');
    await p.emulateMedia({ reducedMotion: 'reduce' });
    const a2 = await ev(p, () => { const d = document.createElement('i'); d.className = 'dot busy'; document.body.appendChild(d); const n = getComputedStyle(d).animationName; d.remove(); return n; });
    check(a2 === 'none', 'reduced motion disables animation: ' + a2);
    await p.context().close();
  });

  await test('20. Terminal and Monitor operate on real data', async () => {
    const p = await newPage(); await openApp(p, 'terminal');
    const run = async (c) => { await p.fill(win('terminal') + ' input', c); await p.press(win('terminal') + ' input', 'Enter'); await p.waitForTimeout(120); };
    await run('mkdir work'); await run('cd work'); await run('echo hello world > h.txt'); await run('mv h.txt g.txt'); await run('cat g.txt'); await run('snapshot via terminal'); await run('verify');
    const out = await p.textContent(win('terminal') + ' .term-out');
    check(/hello world/.test(out) && /OK: \d+ records/.test(out) && /snapshot snap_/.test(out), 'terminal output: ' + out.slice(-200));
    check(await read(p, '/work/g.txt') === 'hello world', 'terminal wrote the real file');
    await run('rm missing.txt'); check(/error: .*not found/i.test(await p.textContent(win('terminal') + ' .term-out')), 'errors reported');
    await openApp(p, 'monitor'); await waitText(p, win('monitor') + ' .grid-stats', /Stored file versions/);
    check(/1 snapshots/.test(await p.textContent(win('monitor'))), 'monitor reflects snapshots');
    await p.click(win('monitor') + ' button:has-text("Reclaim unused space")'); await p.waitForSelector('.toast:has-text("unused stored file version")');
    await p.context().close();
  });

  await test('21. Dark theme renders (screenshot) and no console errors across all apps', async () => {
    const p = await newPage({ colorScheme: 'dark' });
    await ev(p, async () => { const w = CX.shell.ws(); await w.createDir('/src'); await w.createFile('/src/app.js', 'const x = 1;\n'); await w.createSnapshot('first'); });
    for (const id of ['files', 'editor', 'search', 'snapshots', 'journal', 'manifest', 'terminal', 'monitor', 'workspaces', 'settings']) { await openApp(p, id); await p.waitForTimeout(80); }
    check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(8, 10, 16)', 'dark canvas token applied');
    await p.screenshot({ path: '/tmp/dark-all.png' });
    for (const id of ['journal', 'snapshots', 'manifest', 'monitor']) { await openApp(p, id); }
    await p.screenshot({ path: '/tmp/dark-journal.png' });
    check(p.errors.length === 0, 'errors: ' + p.errors.join('|'));
    await p.context().close();
  });


  await test('22. Writes still work when Web Locks are refused (sandboxed frames) and messages use curly quotes', async () => {
    const p = await newPage();
    await ev(p, () => { navigator.locks.request = () => Promise.reject(new DOMException('opaque origin', 'SecurityError')); });
    await ev(p, async () => { await CX.shell.ws().createFile('/locks.txt', 'still works'); });
    check(await read(p, '/locks.txt') === 'still works' && (await journalOk(p)).valid, 'write succeeded and journal valid without Web Locks');
    const m = await ev(p, async () => { try { await CX.shell.ws().createFile('/locks.txt', ''); } catch (e) { return e.message; } });
    check(m === '\u201c/locks.txt\u201d already exists.', 'curly quotes in authored messages: ' + m);
    const tricky = await ev(p, async () => { try { await CX.shell.ws().createFile('/say"hi".txt', ''); await CX.shell.ws().createFile('/say"hi".txt', ''); } catch (e) { return e.message; } });
    check(tricky.includes('say"hi".txt'), 'a typed file name keeps its own quotes: ' + tricky);
    await p.context().close();
  });

  await test('23. First run with v0.9 data tells the user, and changes nothing', async () => {
    const ctx = await browser.newContext(); const p = await ctx.newPage(); await blockFonts(p);
    await p.addInitScript((g) => { if (!sessionStorage.getItem('s')) { localStorage.setItem('cx', g); sessionStorage.setItem('s', '1'); } }, JSON.stringify(v09Fixture(false)));
    await boot(p); await p.waitForSelector('.toast:has-text("v0.9 data was found")');
    check((await ev(p, () => CX.store.listWorkspaces())).length === 1, 'nothing imported automatically');
    await ctx.close();
  });

  await test('24. Performance measurements (reported, not tuned)', async () => {
    const p = await newPage();
    const r = await ev(p, async () => {
      const w = CX.shell.ws(), N = 300, t = []; const t0 = performance.now();
      for (let i = 0; i < N; i++) { const a = performance.now(); await w.createFile('/f' + i + '.txt', 'file number ' + i + '\n'.repeat(20) + 'needle'.repeat(i % 3)); t.push(performance.now() - a); }
      const total = performance.now() - t0; t.sort((a, b) => a - b);
      const v0 = performance.now(); const v = await w.verify(); const vt = performance.now() - v0;
      const s0 = performance.now(); const s = await w.search('needle'); const st = performance.now() - s0;
      const l0 = performance.now(); const l = w.list('/'); const lt = performance.now() - l0;
      const e0 = performance.now(); const pk = await CX.pkg.build(w); const et = performance.now() - e0;
      const big = 'x'.repeat(1024 * 1024); const b0 = performance.now(); await w.createFile('/big1mb.txt', big); const bt = performance.now() - b0;
      return { files: N, createMsMedian: +t[N / 2 | 0].toFixed(1), createMsP95: +t[Math.floor(N * 0.95)].toFixed(1), createMsMax: +t[N - 1].toFixed(1), totalSec: +(total / 1000).toFixed(2), verifyMs: +vt.toFixed(0), verifyRecords: v.count, searchMs: +st.toFixed(0), searchHits: s.results.length, listMs: +lt.toFixed(1), packageBuildMs: +et.toFixed(0), write1MiBMs: +bt.toFixed(0) };
    });
    fs.writeFileSync('/tmp/perf.json', JSON.stringify(r, null, 1)); console.log('      ' + JSON.stringify(r));
    check(r.verifyRecords > 300, 'journal grew');
    await p.context().close();
  });

  await test('25. Deployment: build id, secure context, routes, fonts', async () => {
    const p = await newPage();
    const info = await ev(p, () => ({ secure: isSecureContext, subtle: !!(crypto && crypto.subtle), build: CX.BUILD, version: CX.VERSION, origin: location.origin, path: location.pathname }));
    check(info.secure && info.subtle, 'secure context with SHA-256: ' + JSON.stringify(info));
    check(/^[a-f0-9]{12}$/.test(info.build), 'build id is stamped: ' + info.build);
    if (process.env.EXPECT_BUILD) check(info.build === process.env.EXPECT_BUILD, 'deployed build ' + info.build + ' does not match the expected ' + process.env.EXPECT_BUILD + ' (stale deploy?)');
    const req = p.context().request, get = (u) => req.get(u);
    const main = await get(URL_); check(main.status() === 200 && /text\/html/.test(main.headers()['content-type'] || ''), 'app route returns 200 HTML: ' + main.status());
    if (new URL(URL_).pathname !== '/') { const noSlash = await get(URL_.slice(0, -1)); check(noSlash.status() === 200, 'address without trailing slash still opens the app: ' + noSlash.status()); }
    const leg = await get(URL_ + 'legacy/cx-v0.9.html'); check(leg.status() === 200 && /CX Web v0\.9/.test(await leg.text()), 'v0.9 is still served at legacy/cx-v0.9.html: ' + leg.status());
    const nope = await get(URL_ + '__no_such_page__'); check(nope.status() === 404, 'unknown routes return 404, not a blank app: ' + nope.status());
    await p.reload(); await p.waitForSelector('html[data-cx-ready="1"]'); check((await p.$$('.win')).length >= 2, 'reload on the published address restores the desktop');
    if (process.env.ALLOW_FONTS) {
      const fams = await ev(p, async () => { await document.fonts.load('400 13px Inter'); await document.fonts.load('400 12px "JetBrains Mono"'); return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')); });
      check(fams.includes('Inter') && fams.includes('JetBrains Mono'), 'web fonts actually loaded: ' + JSON.stringify(fams));
    }
    check(p.errors.length === 0, 'console errors: ' + p.errors.join('|'));
    await p.context().close();
  });

  await test('26. Real v0.9 app data round trip: v0.9 writes, Alpha imports, v0.9 still works', async () => {
    if (!REMOTE && !LEGACY) throw new Error('no v0.9 file available');
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } }); const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
    await blockFonts(p);
    const legacyUrl = URL_ + 'legacy/cx-v0.9.html';
    await p.goto(legacyUrl); await p.waitForFunction(() => document.getElementById('status').textContent.includes('Workspace loaded'));
    await p.evaluate(async () => { await fsCreate('/docs', 'd'); await fsCreate('/docs/a.txt', 'f', 'from the real v0.9 code'); await fsCreate('/b.txt', 'f', 'bee'); await transact('note.created', {}, () => { data.notes.push({ text: 'legacy note' }); }); await fsWrite('/b.txt', 'bee two'); });
    const v9 = await p.evaluate(async () => { const v = await verifyJournal(); return { valid: v.valid, count: v.count, issues: v.issues, raw: localStorage.getItem('cx') }; });
    check(v9.valid && v9.count >= 6, 'v0.9 produced a valid chain by its own verifier: ' + JSON.stringify({ c: v9.count, i: v9.issues }));
    await p.goto(URL_); await p.waitForSelector('html[data-cx-ready="1"]');
    await p.waitForSelector('.toast:has-text("v0.9 data was found")');
    await openApp(p, 'workspaces'); await p.click(win('workspaces') + ' button:has-text("Import v0.9 data")'); await dlgOk(p);
    await p.waitForSelector('dialog.dlg:has-text("v0.9 data imported")'); const msg = await p.textContent('dialog.dlg');
    check(/verified \(\d+ records\)/.test(msg), "Alpha's port of the v0.9 verifier accepts the real v0.9 chain: " + msg.slice(0, 140));
    await p.click('dialog.dlg .dlg-actions button:last-child');
    await p.waitForFunction(() => CX.store.listWorkspaces().then((l) => l.length === 2)); await p.waitForTimeout(200);
    const r = await ev(p, async () => { const w = await CX.store.open((await CX.store.listWorkspaces()).find((x) => x.name === 'Imported from v0.9').id);
      return { a: await w.read('/docs/a.txt'), b: await w.read('/b.txt'), n: await w.read('/Notes/note-1.txt'), valid: (await w.verify()).valid, legacyChain: JSON.parse(await w.read('/.cx/legacy/journal-v1.json')).length }; });
    check(r.a === 'from the real v0.9 code' && r.b === 'bee two' && r.n === 'legacy note' && r.valid, 'content and new journal correct: ' + JSON.stringify(r));
    check(r.legacyChain === v9.count, 'the full v0.9 chain is preserved (' + r.legacyChain + ' records)');
    check(await ev(p, (raw) => localStorage.getItem('cx') === raw, v9.raw), 'original v0.9 storage byte-for-byte unchanged after import');
    await p.goto(legacyUrl); await p.waitForFunction(() => document.getElementById('status').textContent.includes('Workspace loaded'));
    const again = await p.evaluate(async () => { const v = await verifyJournal(); return { valid: v.valid, count: v.count, files: Object.keys(data.fs).length }; });
    check(again.valid && again.count === v9.count && again.files === 4, 'v0.9 still opens, verifies and sees its data after Alpha imported it: ' + JSON.stringify(again));
    check(p.errors.length === 0, 'errors: ' + p.errors.join('|'));
    await ctx.close();
  });

  const os = require('os');
  const persistent = async (dir, opts) => { const ctx = await BT.launchPersistentContext(dir, { viewport: { width: 1100, height: 760 }, acceptDownloads: true, ...(opts || {}) }); const p = ctx.pages()[0] || await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); await blockFonts(p); await boot(p); return { ctx, p }; };
  await test('27. Data survives a full browser restart (new browser process, same profile)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-profile-'));
    let s = await persistent(dir);
    await ev(s.p, async () => { const w = CX.shell.ws(); await w.createDir('/keep'); await w.createFile('/keep/restart.txt', 'survives a restart ✓'); await w.createSnapshot('before restart'); await w.updateSettings({ theme: 'dark', fontSize: 17 }); });
    await ev(s.p, () => CX.shell.openApp('editor', { path: '/keep/restart.txt' })); await s.p.waitForSelector(win('editor') + ' .tab:has-text("restart.txt")'); await s.p.waitForTimeout(500);
    const head1 = await ev(s.p, () => CX.shell.ws().rec.headHash);
    await s.ctx.close();
    s = await persistent(dir);
    const r = await ev(s.p, async () => { const w = CX.shell.ws(); return { text: await w.read('/keep/restart.txt'), snaps: (await w.listSnapshots()).map((x) => x.note), theme: w.settings.theme, size: w.settings.fontSize, head: w.rec.headHash, valid: (await w.verify()).valid }; });
    check(r.text === 'survives a restart ✓' && r.snaps.includes('before restart') && r.theme === 'dark' && r.size === 17, 'data and settings after restart: ' + JSON.stringify(r));
    check(r.head === head1 && r.valid, 'journal head identical and valid after restart');
    check(await s.p.$(win('editor') + ' .tab:has-text("restart.txt")') !== null, 'open editor tab restored after restart');
    check(s.p.errors.length === 0, 'errors: ' + s.p.errors.join('|'));
    await s.ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('28. Killing the browser mid-write never leaves a broken workspace (3 kill points)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-kill-'));
    const info = [];
    for (const delay of [8, 30, 90]) {
      let s = await persistent(dir);
      await ev(s.p, async (d) => { window.__b = Promise.all(Array.from({ length: 40 }, (_, i) => CX.shell.ws().createFile('/k' + d + '-' + i + '.txt', 'x'.repeat(3000)).catch(() => {}))); }, delay);
      await s.p.waitForTimeout(delay); await s.ctx.close();                       // abrupt: pages are destroyed with writes in flight
      s = await persistent(dir);
      const r = await ev(s.p, async (d) => { const w = CX.shell.ws(); const v = await w.verify(); let bad = 0; for (const e of w.all()) { try { await w.read(e.path); } catch (_) { bad++; } }
        return { valid: v.valid, issues: v.issues, unreadable: bad, survived: w.all().filter((e) => e.path.startsWith('/k' + d + '-')).length, intentsLeft: (await CX.idb.getAll('intents')).length, recovered: CX.store.recovery().discarded.length }; }, delay);
      info.push(delay + 'ms: ' + r.survived + '/40 committed, recovered ' + r.recovered);
      check(r.valid && r.unreadable === 0 && r.intentsLeft === 0, 'after kill at ' + delay + 'ms: ' + JSON.stringify(r));
      await s.ctx.close();
    }
    fs.writeFileSync('/tmp/kill-results.txt', info.join('\n')); console.log('      ' + info.join(' | '));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await (BROWSER === 'firefox' ? Promise.resolve(skip('29. Android phone profile (Pixel 7 emulation)', 'Playwright cannot emulate mobile in Firefox')) : test('29. Android phone profile (Pixel 7 emulation): full flow and persistence', async () => {
    const dev = pw.devices['Pixel 7'];
    const p = await newPage({ ...dev });
    check(await ev(p, () => innerWidth) === dev.viewport.width, 'phone viewport in use');
    const off = await p.$$eval('#topbar button, #topbar .chip, .win.active .win-title button', (els) => els.filter((e) => e.offsetParent !== null).filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
    check(off === 0, 'no header or window control off-screen');
    await p.tap(win('files') + ' button:has-text("New file")'); await dlgFill(p, 'android.txt');
    await p.waitForSelector(win('editor') + ' textarea:visible'); await p.fill(win('editor') + ' textarea', 'typed on an Android profile');
    await p.tap(win('editor') + ' button:has-text("Save")'); await p.waitForFunction(() => CX.shell.ws().stat('/android.txt').size === 27);
    await p.tap('.dock-btn[data-app="snapshots"]'); await p.fill(win('snapshots') + ' input', 'phone'); await p.tap(win('snapshots') + ' button:has-text("Create snapshot")');
    await p.waitForSelector(win('snapshots') + ' .ws-item:has-text("phone")');
    await p.tap('.dock-btn[data-app="workspaces"]');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.tap(win('workspaces') + ' button:has-text("Export current")')]);
    await dl.saveAs('/tmp/phone.cxpkg.json'); check(fs.statSync('/tmp/phone.cxpkg.json').size > 500, 'export produced a file');
    await p.setInputFiles(win('workspaces') + ' input[type=file]', '/tmp/phone.cxpkg.json'); await p.waitForSelector('dialog.dlg'); await p.tap('dialog.dlg .dlg-actions button:last-child');
    await p.waitForFunction(() => CX.store.listWorkspaces().then((l) => l.length === 2));
    await p.waitForTimeout(400); await boot(p);
    check(await read(p, '/android.txt') === 'typed on an Android profile', 'file survives reload on phone profile');
    check((await journalOk(p)).valid, 'journal valid on phone profile');
    check(p.errors.length === 0, 'errors: ' + p.errors.join('|'));
    await p.context().close();
  }));

  await browser.close(); if (srv) srv.close();
  const pass = results.filter((r) => r.ok).length, skipped = results.filter((r) => r.skipped).length;
  console.log('\n' + pass + '/' + results.length + ' tests passed' + (skipped ? ' (' + skipped + ' skipped)' : ''));
  fs.writeFileSync('/tmp/test-results.json', JSON.stringify(results, null, 1));
  process.exit(pass === results.length ? 0 : 1);
})();
