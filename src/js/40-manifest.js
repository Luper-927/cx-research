'use strict';
// Reads and validates cx.workspace/0.1 manifests. It never executes anything a manifest describes.
CX.manifest = (function () {
  const { canon, sha256, randomId } = CX.util;
  const T = (x) => x;
  const PATH = '/cx.workspace.json';
  const BASE_KINDS = ['devcontainer', 'oci', 'nix', 'wasm', 'none'];
  const COMP_KINDS = ['runtime', 'tool', 'service', 'editor', 'data'];
  const SRC_TYPES = ['oci', 'nix', 'devcontainer-feature', 'wasm', 'files', 'npm', 'pip', 'url'];
  const LEVELS = ['C0', 'C1', 'C2', 'C3', 'C4'];
  const TRUST = ['T0', 'T1', 'T2'];
  const KNOWN = {
    top: ['spec', 'id', 'name', 'revision', 'base', 'strictness', 'components', 'resources', 'burst', 'authority', 'secrets', 'layout'],
    base: ['kind', 'ref', 'digest'],
    component: ['id', 'kind', 'source', 'continuity', 'needs'],
    source: ['type', 'ref', 'digest', 'paths'],
    continuity: ['level', 'state'],
    needs: ['cpu', 'memMiB', 'gpu', 'net'],
    resources: ['min', 'preferred'],
    machine: ['cpu', 'memMiB', 'storageMiB'],
    burst: ['mode', 'allowKinds', 'maxTrust', 'maxPerJobMicroUsd'],
    authority: ['requests'],
    request: ['act', 'res'],
    secret: ['name', 'ref', 'delivery', 'component'],
    layout: ['version', 'data'],
  };
  const FORBIDDEN_TOP = ['grant', 'grants', 'budgetGrant', 'capabilityGrants', 'privateKey', 'keys', 'key'];
  const SECRET_VALUE_KEYS = ['value', 'secret', 'password', 'token', 'apiKey'];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isInt = (v) => Number.isInteger(v);
  const DIGEST = /^sha256:[0-9a-f]{64}$/;

  async function validate(text) {
    const rep = { ok: false, errors: [], warnings: [], unsupported: [], unknown: [], manifest: null, hash: null };
    const err = (path, message, code) => rep.errors.push({ path, message: T(message), code: code || 'E_INVALID' });
    const warn = (path, message) => rep.warnings.push({ path, message: T(message) });
    const uns = (path, feature, reason) => rep.unsupported.push({ path, feature: T(feature), reason: T(reason) });
    let m;
    try { m = JSON.parse(text); }
    catch (e) { err('', 'This is not valid JSON: ' + e.message, 'E_JSON'); return rep; }
    if (!isObj(m)) { err('', 'A manifest must be a JSON object at the top level.', 'E_SHAPE'); return rep; }
    rep.manifest = m;
    const unknownIn = (obj, key, path) => { if (isObj(obj)) Object.keys(obj).forEach((k) => { if (!KNOWN[key].includes(k)) rep.unknown.push(path ? path + '.' + k : k); }); };
    const str = (v) => typeof v === 'string' && v.length > 0;

    if (m.spec !== 'cx.workspace/0.1') {
      if (typeof m.spec === 'string' && m.spec.startsWith('cx.workspace/')) err('spec', 'This build reads cx.workspace/0.1 only. Found “' + m.spec + '”.', 'E_SPEC');
      else err('spec', 'Missing or wrong “spec”. Expected the exact value “cx.workspace/0.1”.', 'E_SPEC');
    }
    if (!(typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m.id))) err('id', '“id” is required: 1 to 64 letters, digits, “_” or “-”.');
    if (!str(m.name)) err('name', '“name” is required and must be a non-empty string.');
    if (!(isInt(m.revision) && m.revision >= 0)) err('revision', '“revision” is required and must be a whole number, 0 or more.');
    FORBIDDEN_TOP.forEach((k) => { if (k in m) err(k, '“' + k + '” must not appear in a manifest. Grants and keys are never stored in manifests.', 'E_FORBIDDEN'); });
    unknownIn(m, 'top', '');

    const strict = m.strictness === undefined ? 'pinned' : m.strictness;
    if (!['pinned', 'floating'].includes(strict)) err('strictness', '“strictness” must be “pinned” or “floating”.');

    if (m.base !== undefined) {
      if (!isObj(m.base)) err('base', '“base” must be an object.');
      else {
        if (!BASE_KINDS.includes(m.base.kind)) err('base.kind', '“base.kind” must be one of: ' + BASE_KINDS.join(', ') + '.');
        if (m.base.kind !== 'none' && m.base.ref !== undefined && !str(m.base.ref)) err('base.ref', '“base.ref” must be a non-empty string.');
        if (m.base.digest !== undefined && !DIGEST.test(m.base.digest)) err('base.digest', 'A digest must look like “sha256:” followed by 64 lowercase hex characters.');
        unknownIn(m.base, 'base', 'base');
        if (m.base.kind && m.base.kind !== 'none') uns('base', 'Rebuilding from “' + m.base.kind + '”', 'Alpha 0.1 reads and validates the base but cannot build or run it.');
      }
    }

    if (m.components !== undefined) {
      if (!Array.isArray(m.components)) err('components', '“components” must be a list.');
      else {
        const ids = new Set();
        m.components.forEach((c, i) => {
          const p = 'components[' + i + ']';
          if (!isObj(c)) return err(p, 'Each component must be an object.');
          if (!str(c.id)) err(p + '.id', 'Component “id” is required.');
          else if (ids.has(c.id)) err(p + '.id', 'Duplicate component id “' + c.id + '”.'); else ids.add(c.id);
          if (!COMP_KINDS.includes(c.kind)) err(p + '.kind', '“kind” must be one of: ' + COMP_KINDS.join(', ') + '.');
          unknownIn(c, 'component', p);
          if (!isObj(c.source)) err(p + '.source', 'Each component needs a “source” object.');
          else {
            const s = c.source;
            if (!SRC_TYPES.includes(s.type)) err(p + '.source.type', '“source.type” must be one of: ' + SRC_TYPES.join(', ') + '.');
            else if (s.type === 'files') { if (!Array.isArray(s.paths) || !s.paths.every(str)) err(p + '.source.paths', 'A “files” source needs a “paths” list of strings.'); }
            else {
              if (!str(s.ref)) err(p + '.source.ref', 'This source type needs a “ref”.');
              if (s.digest !== undefined && !DIGEST.test(s.digest)) err(p + '.source.digest', 'A digest must look like “sha256:” followed by 64 lowercase hex characters.');
              if (s.digest === undefined) {
                if (strict === 'pinned') err(p + '.source.digest', 'This source is not pinned. With strictness “pinned” every non-file source needs a digest. Add one, or set strictness to “floating”.', 'E_UNPINNED');
                else warn(p + '.source', 'Not pinned. Rebuilds may drift over time.');
              }
              uns(p + '.source', 'Fetching “' + s.type + '” sources', 'Alpha 0.1 does not fetch or build components.');
            }
            unknownIn(s, 'source', p + '.source');
          }
          if (!isObj(c.continuity)) err(p + '.continuity', 'Each component needs a “continuity” object with a “level”.');
          else {
            const lv = c.continuity.level;
            if (!LEVELS.includes(lv)) err(p + '.continuity.level', '“level” must be one of C0 to C4.');
            else if (lv === 'C3' || lv === 'C4') err(p + '.continuity.level', lv + ' is not allowed in cx.workspace/0.1. Declare C0, C1 or C2.', 'E_LEVEL');
            else if (lv === 'C1' && !(isObj(c.continuity.state) && (Array.isArray(c.continuity.state.paths) || str(c.continuity.state.strategy)))) err(p + '.continuity.state', 'A component declared C1 must say what state it saves (“state.paths” or “state.strategy”).');
            else if (lv === 'C2') uns(p + '.continuity.level', 'C2 reattachable remote sessions', 'Needs remote display, which is not implemented.');
            unknownIn(c.continuity, 'continuity', p + '.continuity');
          }
          if (c.needs !== undefined) {
            if (!isObj(c.needs)) err(p + '.needs', '“needs” must be an object.');
            else {
              const n = c.needs;
              if (n.cpu !== undefined && !(isInt(n.cpu) && n.cpu >= 1)) err(p + '.needs.cpu', '“cpu” must be a whole number, 1 or more.');
              if (n.memMiB !== undefined && !(isInt(n.memMiB) && n.memMiB >= 1)) err(p + '.needs.memMiB', '“memMiB” must be a whole number, 1 or more.');
              if (n.net !== undefined && !['none', 'egress', 'full'].includes(n.net)) err(p + '.needs.net', '“net” must be none, egress or full.');
              if (n.gpu !== undefined && n.gpu !== null) uns(p + '.needs.gpu', 'GPU requirements', 'No GPU scheduling exists in Alpha 0.1.');
              unknownIn(n, 'needs', p + '.needs');
            }
          }
        });
      }
    }

    if (m.resources !== undefined) {
      if (!isObj(m.resources)) err('resources', '“resources” must be an object.');
      else {
        unknownIn(m.resources, 'resources', 'resources');
        ['min', 'preferred'].forEach((k) => {
          const r = m.resources[k]; if (r === undefined) return;
          if (!isObj(r)) return err('resources.' + k, '“' + k + '” must be an object.');
          ['cpu', 'memMiB', 'storageMiB'].forEach((f) => { if (r[f] !== undefined && !(isInt(r[f]) && r[f] >= 0)) err('resources.' + k + '.' + f, '“' + f + '” must be a whole number, 0 or more.'); });
          unknownIn(r, 'machine', 'resources.' + k);
        });
      }
    }

    if (m.burst !== undefined) {
      if (!isObj(m.burst)) err('burst', '“burst” must be an object.');
      else {
        const b = m.burst;
        if (!['never', 'ask', 'auto-within-grant'].includes(b.mode)) err('burst.mode', '“mode” must be never, ask or auto-within-grant.');
        if (b.maxTrust !== undefined && !TRUST.includes(b.maxTrust)) err('burst.maxTrust', '“maxTrust” must be T0, T1 or T2.');
        if (b.maxPerJobMicroUsd !== undefined && !(typeof b.maxPerJobMicroUsd === 'string' && /^\d+$/.test(b.maxPerJobMicroUsd))) err('burst.maxPerJobMicroUsd', 'Money is a string of digits in micro-USD, for example “0”.');
        if (b.allowKinds !== undefined && !(Array.isArray(b.allowKinds) && b.allowKinds.every(str))) err('burst.allowKinds', '“allowKinds” must be a list of strings.');
        unknownIn(b, 'burst', 'burst');
        if (b.mode && b.mode !== 'never') uns('burst', 'Remote burst (mode “' + b.mode + '”)', 'Remote execution is not implemented. Nothing will run remotely.');
        if (b.mode === 'auto-within-grant') warn('burst.mode', '“auto-within-grant” needs a budget grant. None can exist yet, so it would fall back to “ask”.');
      }
    }

    if (m.authority !== undefined) {
      if (!isObj(m.authority)) err('authority', '“authority” must be an object.');
      else {
        unknownIn(m.authority, 'authority', 'authority');
        if (m.authority.requests !== undefined) {
          if (!Array.isArray(m.authority.requests)) err('authority.requests', '“requests” must be a list.');
          else {
            m.authority.requests.forEach((r, i) => {
              const p = 'authority.requests[' + i + ']';
              if (!isObj(r)) return err(p, 'Each request must be an object.');
              if (!(Array.isArray(r.act) && r.act.length && r.act.every(str))) err(p + '.act', '“act” must be a non-empty list of strings.');
              if (!(typeof r.res === 'string' && r.res.startsWith('cx:'))) err(p + '.res', '“res” must be a resource starting with “cx:”.');
              unknownIn(r, 'request', p);
            });
            if (m.authority.requests.length) uns('authority.requests', 'Capability enforcement', 'Requests are recorded but nothing enforces or grants them in Alpha 0.1.');
          }
        }
      }
    }

    if (m.secrets !== undefined) {
      if (!Array.isArray(m.secrets)) err('secrets', '“secrets” must be a list.');
      else {
        m.secrets.forEach((s, i) => {
          const p = 'secrets[' + i + ']';
          if (!isObj(s)) return err(p, 'Each secret entry must be an object.');
          if (!str(s.name)) err(p + '.name', '“name” is required.');
          if (!str(s.ref)) err(p + '.ref', '“ref” is required. Secrets are referenced, never stored in a manifest.');
          SECRET_VALUE_KEYS.forEach((k) => { if (k in s) err(p + '.' + k, 'Secret values must never be written in a manifest. Remove “' + k + '” and use “ref”.', 'E_SECRET_VALUE'); });
          if (s.delivery !== undefined && !['env', 'file'].includes(s.delivery)) err(p + '.delivery', '“delivery” must be env or file.');
          unknownIn(s, 'secret', p);
        });
        if (m.secrets.length) uns('secrets', 'Secret delivery', 'Alpha 0.1 has no secret store or runtime to deliver secrets to.');
      }
    }

    if (m.layout !== undefined) {
      if (!isObj(m.layout)) err('layout', '“layout” must be an object.');
      else { if (m.layout.version !== undefined && !isInt(m.layout.version)) err('layout.version', '“version” must be a whole number.'); unknownIn(m.layout, 'layout', 'layout'); }
    }
    rep.unknown = [...new Set(rep.unknown)];
    rep.ok = rep.errors.length === 0;
    try { rep.hash = await sha256(canon(m)); } catch (_) { /* hash only when canonicalisable */ }
    return rep;
  }
  function template(wsName) {
    return JSON.stringify({
      spec: 'cx.workspace/0.1', id: randomId('ws_'), name: wsName, revision: 1, strictness: 'floating',
      components: [{ id: 'files', kind: 'data', source: { type: 'files', paths: ['/'] }, continuity: { level: 'C0' } }],
      burst: { mode: 'never', maxPerJobMicroUsd: '0' },
    }, null, 2) + '\n';
  }
  return { PATH, validate, template };
})();
