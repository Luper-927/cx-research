// A small static server that behaves like GitHub Pages for CX: serves index.html and legacy/cx-v0.9.html under a path prefix,
// redirects "/prefix" to "/prefix/", and returns 404 for everything else. Used for local runs only.
const http = require('http'), fs = require('fs');
module.exports = function serve({ index, legacy, prefix }) {
  prefix = prefix || '/';
  const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type || 'text/html; charset=utf-8' }); res.end(body); };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (prefix !== '/' && p === prefix.slice(0, -1)) { res.writeHead(301, { location: prefix }); return res.end(); }
    if (!p.startsWith(prefix)) return send(res, 404, '<h1>404</h1>');
    const rel = p.slice(prefix.length);
    if (rel === '' || rel === 'index.html') return send(res, 200, fs.readFileSync(index));
    if (rel === 'legacy/cx-v0.9.html' && legacy && fs.existsSync(legacy)) return send(res, 200, fs.readFileSync(legacy));
    return send(res, 404, '<h1>404</h1>');
  });
};
