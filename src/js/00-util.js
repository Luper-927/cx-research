'use strict';
window.CX = window.CX || {};
CX.VERSION = '0.1.0-alpha';
CX.BUILD = '__BUILD__';   // replaced by build.js with a hash of the source
CX.ZERO = 'sha256:' + '0'.repeat(64);

CX.bus = (function () {
  const m = new Map();
  return {
    on(t, f) { (m.get(t) || m.set(t, new Set()).get(t)).add(f); return () => m.get(t).delete(f); },
    emit(t, d) { (m.get(t) || []).forEach((f) => { try { f(d); } catch (e) { console.error('bus handler', t, e); } }); },
  };
})();

CX.util = (function () {
  class CxError extends Error {
    constructor(code, message, details) { super(message); this.name = 'CxError'; this.code = code; this.details = details || null; }
  }
  const enc = new TextEncoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  async function sha256Hex(text) {
    if (!(window.crypto && crypto.subtle)) throw new CxError('E_NO_CRYPTO', 'SHA-256 is unavailable. Open CX over HTTPS or localhost.');
    return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  }
  const sha256 = async (text) => 'sha256:' + (await sha256Hex(text));
  // Sorted-key JSON. Matches RFC 8785 for the value types CX uses (strings, booleans, null, safe integers).
  // Not yet validated against the RFC test vectors.
  function canon(v) {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new CxError('E_CANON', 'Non-finite number'); return JSON.stringify(v); }
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (typeof v === 'object') {
      const k = Object.keys(v).filter((x) => v[x] !== undefined).sort();
      return '{' + k.map((x) => JSON.stringify(x) + ':' + canon(v[x])).join(',') + '}';
    }
    throw new CxError('E_CANON', 'Unsupported value in canonical JSON');
  }
  function randomId(prefix) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const byteLength = (s) => enc.encode(s).length;

  // paths
  const MAX_NAME = 255, MAX_PATH = 4096;
  const validName = (n) => typeof n === 'string' && n.length > 0 && n.length <= MAX_NAME && !n.includes('/') && n !== '.' && n !== '..' && !/[\u0000-\u001f]/.test(n) && n === n.trim();
  function validPath(p) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > MAX_PATH) return false;
    if (p === '/') return true;
    if (p.endsWith('/')) return false;
    return p.slice(1).split('/').every(validName);
  }
  const parentOf = (p) => (p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/');
  const nameOf = (p) => (p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1));
  const joinPath = (d, n) => (d === '/' ? '/' + n : d + '/' + n);
  function resolvePath(p, base) {
    const out = [];
    for (const s of (p.startsWith('/') ? p : base + '/' + p).split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return '/' + out.join('/');
  }

  // formatting
  function fmtBytes(n) {
    if (n == null || isNaN(n)) return 'n/a';
    if (n < 1024) return n + ' B';
    const u = ['KiB', 'MiB', 'GiB', 'TiB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
  }
  const fmtTime = (t) => { try { return new Date(t).toLocaleString(); } catch (e) { return String(t); } };
  const shortHash = (h) => (h ? String(h).replace('sha256:', '').slice(0, 12) : '');
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';

  // DOM builder. Never uses innerHTML for data.
  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'tabIndex', 'open']);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return el;
  }
  const ICONS = {
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    file: 'M6 3h8l4 4v14H6z M14 3v4h4',
    edit: 'M4 20h4L19 9l-4-4L4 16z',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4',
    snap: 'M4 8h3l2-3h6l2 3h3v11H4z M12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    journal: 'M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z M9 8h6 M9 12h6',
    manifest: 'M9 4C7 4 7 6 7 8s0 3-2 4c2 1 2 2 2 4s0 4 2 4 M15 4c2 0 2 2 2 4s0 3 2 4c-2 1-2 2-2 4s0 4-2 4',
    pulse: 'M3 12h4l3-8 4 16 3-8h4',
    grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
    sliders: 'M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 4v6 M6 14v6',
    term: 'M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5',
    cmd: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
    moon: 'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z',
    up: 'M12 19V5 M6 11l6-6 6 6',
    plus: 'M12 5v14 M5 12h14',
    trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13',
    x: 'M6 6l12 12 M18 6L6 18',
    min: 'M6 18h12',
    max: 'M5 5h14v14H5z',
    upload: 'M12 16V4 M7 9l5-5 5 5 M5 20h14',
    download: 'M12 4v12 M7 11l5 5 5-5 M5 20h14',
    rename: 'M4 20h16 M7 16l1-4 8-8 3 3-8 8z',
    save: 'M5 4h12l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6',
    check: 'M5 12l5 5 9-10',
  };
  function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'icon'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name] || ICONS.file); s.appendChild(p); return s;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // Hands a text file to the user. Uses the viewer's downloads capability inside a published
  // artifact, and a normal download link everywhere else.
  async function saveTextFile(filename, text) {
    try {
      if (window.claude && typeof window.claude.use === 'function') {
        const d = await window.claude.use('downloads');
        if (d) { await d.save({ filename, data: text }); return 'saved'; }
      }
    } catch (e) { if (e && e.code === 'declined') return 'declined'; throw new CxError('E_EXPORT', 'Could not save file: ' + (e && e.message ? e.message : e)); }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: filename }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'saved';
  }

  return { CxError, sha256, sha256Hex, canon, randomId, byteLength, validName, validPath, parentOf, nameOf, joinPath, resolvePath,
    fmtBytes, fmtTime, shortHash, slug, h, icon, debounce, saveTextFile, MAX_NAME };
})();
