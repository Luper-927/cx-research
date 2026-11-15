// Checks every project file against SOURCES.sha256, so a copy-and-paste mistake is reported by file name.
// Line endings and trailing blank lines are ignored; everything else must match exactly.
// Usage: node scripts/verify-sources.js          (check)
//        node scripts/verify-sources.js --write  (regenerate SOURCES.sha256 from the files on disk)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const FILES = [
  '.gitignore', 'package.json', 'build.js', 'README.md', 'TEST-REPORT.md', '.github/workflows/pages.yml', 'legacy/README.md',
  'scripts/verify-sources.js', 'src/template.html', 'src/css/lumina.css',
  'src/js/00-util.js', 'src/js/10-idb.js', 'src/js/20-store.js', 'src/js/40-manifest.js', 'src/js/50-package.js', 'src/js/60-legacy.js',
  'src/js/70-ui.js', 'src/js/71-shell.js', 'src/js/72-app-files.js', 'src/js/73-app-tools.js', 'src/js/74-app-system.js', 'src/js/90-main.js',
  'tests/run.js', 'tests/serve.js', 'tests/scale.js', 'tests/fixtures/cx-v0.9.html',
];
const norm = (t) => t.replace(/\r\n/g, '\n').replace(/\s+$/, '');
const hash = (f) => crypto.createHash('sha256').update(norm(fs.readFileSync(path.join(root, f), 'utf8'))).digest('hex');
const sums = path.join(root, 'SOURCES.sha256');
if (process.argv.includes('--write')) {
  fs.writeFileSync(sums, FILES.map((f) => hash(f) + '  ' + f).join('\n') + '\n');
  console.log('wrote SOURCES.sha256 for ' + FILES.length + ' files');
  process.exit(0);
}
const want = new Map(fs.readFileSync(sums, 'utf8').split('\n').filter(Boolean).map((l) => { const m = /^([a-f0-9]{64})  (.+)$/.exec(l); return [m[2], m[1]]; }));
let bad = 0;
for (const f of FILES) {
  if (!fs.existsSync(path.join(root, f))) { console.error('MISSING   ' + f); bad++; continue; }
  if (hash(f) !== want.get(f)) { console.error('DIFFERENT ' + f + '  (re-paste this file exactly)'); bad++; }
}
if (bad) { console.error('\n' + bad + ' file(s) are missing or different.'); process.exit(1); }
console.log('all ' + FILES.length + ' files match SOURCES.sha256');
