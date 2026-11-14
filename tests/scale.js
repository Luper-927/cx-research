// Scale measurements (reported, not asserted): N files in one workspace. Run: node tests/scale.js [N]
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const N = parseInt(process.argv[2] || '2000', 10);
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync(path.join(__dirname, '../dist/index.html'))); });
(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.route(/fonts\./, (r) => r.abort()); await p.goto('http://127.0.0.1:' + srv.address().port + '/'); await p.waitForSelector('html[data-cx-ready="1"]');
  const r = await p.evaluate(async (N) => {
    const ms = (t) => +(performance.now() - t).toFixed(0), w = CX.shell.ws(), out = { files: N }, lat = [];
    await w.createDir('/data');
    for (let i = 0; i < N; i++) { const t = performance.now(); await w.createFile('/data/file-' + String(i).padStart(5, '0') + '.txt', 'content of file ' + i + '\n' + 'lorem ipsum '.repeat(40) + (i % 50 === 0 ? 'NEEDLE' : '')); lat.push(performance.now() - t); }
    lat.sort((a, c) => a - c); const q = (f) => +lat[Math.floor(lat.length * f)].toFixed(1);
    out.createMsMedian = q(0.5); out.createMsP95 = q(0.95); out.createMsMax = +lat[lat.length - 1].toFixed(1);
    let t = performance.now(); const v = await w.verify(); out.verifyMs = ms(t); out.verifyValid = v.valid; out.journalRecords = v.count;
    t = performance.now(); const s = await w.search('NEEDLE', { limit: 1000 }); out.searchMs = ms(t); out.searchHits = s.results.length;
    t = performance.now(); const sn = await w.createSnapshot('scale'); out.snapshotCreateMs = ms(t);
    for (let i = 0; i < 200; i++) await w.writeFile('/data/file-' + String(i).padStart(5, '0') + '.txt', 'changed ' + i);
    await w.remove('/data/file-01999.txt');
    t = performance.now(); await w.restoreSnapshot(sn.id); out.restoreMs = ms(t); out.restoredFiles = w.all().filter((e) => e.type === 'file').length;
    t = performance.now(); const pkg = await CX.pkg.build(w); out.exportBuildMs = ms(t); const text = JSON.stringify(pkg); out.exportMiB = +(text.length / 1048576).toFixed(2);
    t = performance.now(); const v2 = await CX.pkg.validate(JSON.parse(text)); out.importValidateMs = ms(t); out.importValid = v2.ok;
    t = performance.now(); const imp = await CX.pkg.importPackage(JSON.parse(text)); out.importWriteMs = ms(t); out.importedVerify = (await imp.verify()).valid;
    CX.shell.closeApp('files'); await new Promise((r) => setTimeout(r, 50));
    const rows = () => document.querySelectorAll('.win[data-app="files"] .row').length;
    CX.shell.ws().saveUi({ windows: [{ app: 'files', x: 12, y: 12, w: 600, h: 700, z: 1 }], apps: { files: { cwd: '/data', sel: null } } });
    await CX.shell.setWorkspace(await CX.store.open(CX.shell.ws().id)); await new Promise((r) => setTimeout(r, 100));
    t = performance.now(); CX.shell.openApp('files', { cwd: '/data' }); out.renderRowsMs = ms(t); out.rowsRendered = rows();
    out.storage = await CX.store.stats().then((s) => ({ blobs: s.blobCount, blobMiB: +(s.blobBytes / 1048576).toFixed(2) }));
    return out;
  }, N);
  console.log(JSON.stringify(r, null, 1)); fs.writeFileSync('/tmp/scale.json', JSON.stringify(r));
  await b.close(); srv.close();
})().catch((e) => { console.log('SCALE FAIL', e.message); process.exit(1); });
