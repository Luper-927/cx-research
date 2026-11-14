// Builds CX Alpha from src/ with no dependencies.
//   node build.js                 -> dist/index.html (one self-contained file) and dist/build-id.txt
//   node build.js --site          -> also assembles _site/ (what GitHub Pages publishes)
//   node build.js --site --require-legacy   -> fail if legacy/cx-v0.9.html is missing
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = __dirname, src = path.join(root, 'src');
const css = fs.readFileSync(path.join(src, 'css/lumina.css'), 'utf8');
let js = fs.readdirSync(path.join(src, 'js')).filter((f) => f.endsWith('.js')).sort().map((f) => '/* ' + f + ' */\n' + fs.readFileSync(path.join(src, 'js', f), 'utf8')).join('\n');
const tpl = fs.readFileSync(path.join(src, 'template.html'), 'utf8');
if (js.includes('</script')) throw new Error('JS contains </script');
const id = crypto.createHash('sha256').update(tpl + '\0' + css + '\0' + js).digest('hex').slice(0, 12);
js = js.split('__BUILD__').join(id);
const html = tpl.replace('/*CSS*/', () => css).replace('/*JS*/', () => js);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), html);
fs.writeFileSync(path.join(root, 'dist/build-id.txt'), id + '\n');
console.log('built dist/index.html', (html.length / 1024).toFixed(1) + ' KiB', 'build', id);
if (process.argv.includes('--site')) {
  const site = path.join(root, '_site');
  fs.rmSync(site, { recursive: true, force: true }); fs.mkdirSync(path.join(site, 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), html);
  fs.writeFileSync(path.join(site, '.nojekyll'), '');
  const legacy = path.join(root, 'legacy/cx-v0.9.html');
  if (fs.existsSync(legacy)) fs.copyFileSync(legacy, path.join(site, 'legacy/cx-v0.9.html'));
  else if (process.argv.includes('--require-legacy')) { console.error('legacy/cx-v0.9.html is missing'); process.exit(1); }
  else console.warn('warning: legacy/cx-v0.9.html not found; _site has no legacy copy');
  console.log('assembled _site/', fs.readdirSync(site, { recursive: true }).join(', '));
}
