// CX Knowledge Validity Engine. Pure JS, no dependencies, no clock, no randomness, no LLM.
// Semantics are documented in SEMANTICS.md.

export const S = Object.freeze({
  VALID: 'VALID',
  REASSESS: 'NEEDS_REASSESSMENT',
  UNSUPPORTED: 'UNSUPPORTED',
  RETRACTED: 'RETRACTED',
  SUPERSEDED: 'SUPERSEDED',
});

export class ValidityError extends Error {
  constructor(code, msg) {
    super(code + ': ' + msg);
    this.code = code;
  }
}

const MUTATORS = [
  'addEvidence', 'addClaim', 'justify', 'withdrawEvidence',
  'replaceEvidence', 'retract', 'supersede', 'declareContradiction',
];

const uniqSorted = (a) => [...new Set(a)].sort();
const copy = (x) => JSON.parse(JSON.stringify(x));

export class ValidityEngine {
  constructor() {
    this.claims = Object.create(null);   // id -> {id,text,life,supersededBy,state,wasValid}
    this.evidence = Object.create(null); // id -> {id,text,active,replacedBy}
    this.justs = Object.create(null);    // id -> {id,claim,premises[],evidence[]}  (premises AND evidence all required)
    this.contradictions = []; // sorted [a,b] pairs
    this.history = [];
    this.seq = 0;
    this._idx = null; // derived cache: claim id -> sorted justifications (not serialized)
  }

  // ---------- mutators (each validates fully BEFORE mutating) ----------

  addEvidence(id, text = '') {
    return this._op('addEvidence', [id, text], () => {
      this._fresh(this.evidence, id, 'evidence');
      this.evidence[id] = { id, text, active: true, replacedBy: null };
    });
  }

  addClaim(id, text = '') {
    return this._op('addClaim', [id, text], () => {
      this._fresh(this.claims, id, 'claim');
      this.claims[id] = { id, text, life: 'ACTIVE', supersededBy: null, state: S.UNSUPPORTED, wasValid: false };
    });
  }

  // One justification = one independent derivation. All its premises and evidence are required.
  justify(justId, claimId, { premises = [], evidence = [] } = {}) {
    return this._op('justify', [justId, claimId, { premises, evidence }], () => {
      this._fresh(this.justs, justId, 'justification');
      const c = this.claims[claimId];
      if (!c) throw new ValidityError('UNKNOWN_CLAIM', claimId);
      if (c.life !== 'ACTIVE') throw new ValidityError('INVALID_DEPENDENCY', `${claimId} is ${c.life}`);
      const ps = uniqSorted(premises), es = uniqSorted(evidence);
      if (!ps.length && !es.length) throw new ValidityError('EMPTY_JUSTIFICATION', justId);
      for (const p of ps) {
        const pc = this.claims[p];
        if (!pc) throw new ValidityError('UNKNOWN_CLAIM', p);
        if (pc.life !== 'ACTIVE') throw new ValidityError('INVALID_DEPENDENCY', `${p} is ${pc.life}`);
      }
      for (const e of es) {
        if (!this.evidence[e]) throw new ValidityError('UNKNOWN_EVIDENCE', e);
        if (!this._evOk(e)) throw new ValidityError('INVALID_DEPENDENCY', `evidence ${e} is withdrawn`);
      }
      for (const p of ps) {
        if (p === claimId || this._upstream(p).has(claimId)) {
          throw new ValidityError('CYCLE', `${claimId} <- ${p}`);
        }
      }
      this.justs[justId] = { id: justId, claim: claimId, premises: ps, evidence: es };
      this._idx = null;
    });
  }

  withdrawEvidence(id, reason = '') {
    return this._op('withdrawEvidence', [id, reason], () => {
      const e = this.evidence[id];
      if (!e) throw new ValidityError('UNKNOWN_EVIDENCE', id);
      if (!e.active) throw new ValidityError('ALREADY_WITHDRAWN', id);
      e.active = false;
    });
  }

  // Old evidence is withdrawn; justifications that cited it are satisfied by the new evidence.
  replaceEvidence(oldId, newId, text = '') {
    return this._op('replaceEvidence', [oldId, newId, text], () => {
      const e = this.evidence[oldId];
      if (!e) throw new ValidityError('UNKNOWN_EVIDENCE', oldId);
      if (!e.active) throw new ValidityError('ALREADY_WITHDRAWN', oldId);
      this._fresh(this.evidence, newId, 'evidence');
      e.active = false;
      e.replacedBy = newId;
      this.evidence[newId] = { id: newId, text, active: true, replacedBy: null };
    });
  }

  retract(id, reason = '') {
    return this._op('retract', [id, reason], () => {
      const c = this.claims[id];
      if (!c) throw new ValidityError('UNKNOWN_CLAIM', id);
      if (c.life !== 'ACTIVE') throw new ValidityError('ALREADY_TERMINAL', `${id} is ${c.life}`);
      c.life = 'RETRACTED';
    });
  }

  // Dependents are NOT migrated to the successor; they go to reassessment.
  supersede(oldId, newId, text = '') {
    return this._op('supersede', [oldId, newId, text], () => {
      const c = this.claims[oldId];
      if (!c) throw new ValidityError('UNKNOWN_CLAIM', oldId);
      if (c.life !== 'ACTIVE') throw new ValidityError('ALREADY_TERMINAL', `${oldId} is ${c.life}`);
      this._fresh(this.claims, newId, 'claim');
      c.life = 'SUPERSEDED';
      c.supersededBy = newId;
      this.claims[newId] = { id: newId, text, life: 'ACTIVE', supersededBy: null, state: S.UNSUPPORTED, wasValid: false };
    });
  }

  // Never changes validity. Both claims coexist; see conflicts().
  declareContradiction(a, b) {
    return this._op('declareContradiction', [a, b], () => {
      for (const x of [a, b]) if (!this.claims[x]) throw new ValidityError('UNKNOWN_CLAIM', x);
      if (a === b) throw new ValidityError('INVALID_DEPENDENCY', 'claim cannot contradict itself');
      const pair = [a, b].sort();
      if (this.contradictions.some((p) => p[0] === pair[0] && p[1] === pair[1])) {
        throw new ValidityError('DUPLICATE_ID', `contradiction ${pair.join('~')}`);
      }
      this.contradictions.push(pair);
      this.contradictions.sort((x, y) => (x[0] + '\0' + x[1]).localeCompare(y[0] + '\0' + y[1]));
    });
  }

  // ---------- queries ----------

  state(id) {
    this._need(id);
    return this.claims[id].state;
  }

  // Remaining support: which justifications hold, which are broken and why.
  support(id) {
    this._need(id);
    const js = this._justsOf(id).map((j) => {
      const missing = [];
      for (const p of j.premises) {
        if (this.claims[p].state !== S.VALID) missing.push({ type: 'claim', id: p, why: this.claims[p].state });
      }
      for (const e of j.evidence) if (!this._evOk(e)) missing.push({ type: 'evidence', id: e, why: 'withdrawn' });
      return { id: j.id, satisfied: missing.length === 0, missing };
    });
    return { claim: id, state: this.claims[id].state, remaining: js.filter((j) => j.satisfied).length, justifications: js };
  }

  // Upstream: everything this claim's justifications transitively rely on.
  dependencies(id) {
    this._need(id);
    const claims = new Set(), ev = new Set(), stack = [id];
    while (stack.length) {
      for (const j of this._justsOf(stack.pop())) {
        for (const p of j.premises) if (!claims.has(p)) { claims.add(p); stack.push(p); }
        for (const e of j.evidence) ev.add(e);
      }
    }
    return { claims: [...claims].sort(), evidence: [...ev].sort() };
  }

  // Downstream: every claim that transitively relies on this claim.
  dependents(id) {
    this._need(id);
    return this._downstream(this._directOfClaim(id));
  }

  // Downstream of evidence (follows replacement chains).
  dependentsOfEvidence(id) {
    if (!this.evidence[id]) throw new ValidityError('UNKNOWN_EVIDENCE', id);
    const family = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of Object.values(this.evidence)) {
        if (e.replacedBy && family.has(e.replacedBy) && !family.has(e.id)) { family.add(e.id); grew = true; }
      }
    }
    const direct = new Set();
    for (const j of Object.values(this.justs)) if (j.evidence.some((e) => family.has(e))) direct.add(j.claim);
    return this._downstream([...direct]);
  }

  conflicts() {
    return this.contradictions.map(([a, b]) => ({
      a, b,
      status: this.claims[a].state === S.VALID && this.claims[b].state === S.VALID ? 'LIVE' : 'DORMANT',
    }));
  }

  // Dry run on a clone. Real engine is untouched.
  preview(op, ...args) {
    if (!MUTATORS.includes(op)) throw new Error('not a mutator: ' + op);
    const clone = ValidityEngine.fromJSON(this.snapshot());
    try {
      const e = clone[op](...args);
      return { rejected: false, changes: e.changes, degraded: e.degraded };
    } catch (err) {
      if (err instanceof ValidityError) return { rejected: true, error: err.code, changes: [], degraded: [] };
      throw err;
    }
  }

  snapshot() {
    return copy({
      claims: this.claims, evidence: this.evidence, justs: this.justs,
      contradictions: this.contradictions, history: this.history, seq: this.seq,
    });
  }

  static fromJSON(s) {
    const e = new ValidityEngine();
    const d = copy(s);
    for (const k of ['claims', 'evidence', 'justs']) Object.assign(e[k], d[k]);
    e.contradictions = d.contradictions;
    e.seq = d.seq;
    e.history = d.history.map((h) => Object.freeze(h));
    return e;
  }

  // Rebuild purely from the recorded operations (including rejected ones).
  static replay(history) {
    const e = new ValidityEngine();
    for (const h of history) {
      try { e[h.op](...copy(h.args)); } catch (err) { if (!(err instanceof ValidityError)) throw err; }
    }
    return e;
  }

  // ---------- internals ----------

  _op(op, args, fn) {
    const before = this._summary();
    const entry = { seq: ++this.seq, op, args: copy(args) };
    try {
      fn();
    } catch (err) {
      if (!(err instanceof ValidityError)) { this.seq--; throw err; }
      Object.assign(entry, { outcome: 'rejected', error: err.code, message: err.message, changes: [], degraded: [] });
      this.history.push(Object.freeze(entry));
      throw err;
    }
    this._recompute();
    const after = this._summary();
    const changes = [], degraded = [];
    for (const id of Object.keys(after).sort()) {
      const b = before[id], a = after[id];
      if (!b || b.state !== a.state) changes.push({ id, from: b ? b.state : null, to: a.state });
      else if (a.state === S.VALID && a.n < b.n) degraded.push({ id, justificationsBefore: b.n, justificationsAfter: a.n });
    }
    Object.assign(entry, { outcome: 'applied', changes, degraded });
    Object.freeze(entry);
    this.history.push(entry);
    return entry;
  }

  _recompute() {
    const memo = {};
    const valid = (id) => {
      if (id in memo) return memo[id];
      memo[id] = false; // graph is acyclic by construction; guard only
      const c = this.claims[id];
      const v = c.life === 'ACTIVE' &&
        this._justsOf(id).some((j) => j.premises.every(valid) && j.evidence.every((e) => this._evOk(e)));
      return (memo[id] = v);
    };
    for (const id of Object.keys(this.claims).sort()) {
      const c = this.claims[id];
      if (c.life !== 'ACTIVE') c.state = c.life === 'RETRACTED' ? S.RETRACTED : S.SUPERSEDED;
      else if (valid(id)) { c.state = S.VALID; c.wasValid = true; }
      else c.state = this._justsOf(id).length ? S.REASSESS : S.UNSUPPORTED;
    }
  }

  _summary() {
    const out = {};
    for (const id of Object.keys(this.claims)) {
      const n = this._justsOf(id).filter((j) =>
        j.premises.every((p) => this.claims[p].state === S.VALID) && j.evidence.every((e) => this._evOk(e))).length;
      out[id] = { state: this.claims[id].state, n };
    }
    return out;
  }

  _evOk(id) {
    let e = this.evidence[id];
    while (e && !e.active && e.replacedBy) e = this.evidence[e.replacedBy];
    return !!e && e.active;
  }

  _justsOf(claimId) {
    if (!this._idx) {
      this._idx = new Map();
      for (const j of Object.values(this.justs).sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!this._idx.has(j.claim)) this._idx.set(j.claim, []);
        this._idx.get(j.claim).push(j);
      }
    }
    return this._idx.get(claimId) || [];
  }

  _upstream(id) {
    const seen = new Set(), stack = [id];
    while (stack.length) {
      for (const j of this._justsOf(stack.pop())) {
        for (const p of j.premises) if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return seen;
  }

  _directOfClaim(id) {
    return uniqSorted(Object.values(this.justs).filter((j) => j.premises.includes(id)).map((j) => j.claim));
  }

  _downstream(start) {
    const seen = new Set(start), stack = [...start];
    while (stack.length) for (const n of this._directOfClaim(stack.pop())) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    return [...seen].sort();
  }

  _fresh(table, id, kind) {
    if (typeof id !== 'string' || !id) throw new ValidityError('INVALID_ID', String(id));
    if (id in table) throw new ValidityError('DUPLICATE_ID', `${kind} ${id}`);
  }

  _need(id) {
    if (!this.claims[id]) throw new ValidityError('UNKNOWN_CLAIM', id);
  }
}
