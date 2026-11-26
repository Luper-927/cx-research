import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidityEngine, ValidityError, S } from './engine.mjs';

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof ValidityError && e.code === code, `expected ${code}`);

// Chain: e1 -> A -> B -> C
function chain() {
  const g = new ValidityEngine();
  g.addEvidence('e1', 'measurement');
  g.addClaim('A'); g.addClaim('B'); g.addClaim('C');
  g.justify('jA', 'A', { evidence: ['e1'] });
  g.justify('jB', 'B', { premises: ['A'] });
  g.justify('jC', 'C', { premises: ['B'] });
  return g;
}

test('simple chain: derivation makes all valid', () => {
  const g = chain();
  for (const id of ['A', 'B', 'C']) assert.equal(g.state(id), S.VALID);
  assert.deepEqual(g.dependencies('C'), { claims: ['A', 'B'], evidence: ['e1'] });
  assert.deepEqual(g.dependents('A'), ['B', 'C']);
});

test('chain: evidence withdrawal marks dependents for reassessment, not false', () => {
  const g = chain();
  const e = g.withdrawEvidence('e1', 'instrument fault');
  assert.deepEqual(e.changes.map((c) => [c.id, c.to]),
    [['A', S.REASSESS], ['B', S.REASSESS], ['C', S.REASSESS]]);
  const sup = g.support('B');
  assert.equal(sup.remaining, 0);
  assert.deepEqual(sup.justifications[0].missing, [{ type: 'claim', id: 'A', why: S.REASSESS }]);
  assert.deepEqual(g.support('A').justifications[0].missing, [{ type: 'evidence', id: 'e1', why: 'withdrawn' }]);
});

test('branching graph: only the affected branch is reassessed', () => {
  const g = new ValidityEngine();
  g.addEvidence('e1'); g.addEvidence('e2');
  for (const c of ['P', 'Q', 'R', 'S1']) g.addClaim(c);
  g.justify('jP', 'P', { evidence: ['e1'] });
  g.justify('jQ', 'Q', { evidence: ['e2'] });
  g.justify('jR', 'R', { premises: ['P'] });
  g.justify('jS', 'S1', { premises: ['P', 'Q'] }); // conjunctive
  g.withdrawEvidence('e2');
  assert.equal(g.state('P'), S.VALID);
  assert.equal(g.state('R'), S.VALID);
  assert.equal(g.state('Q'), S.REASSESS);
  assert.equal(g.state('S1'), S.REASSESS);
});

test('multiple independent justifications: losing one keeps the claim valid', () => {
  const g = new ValidityEngine();
  g.addEvidence('e1'); g.addEvidence('e2'); g.addClaim('X');
  g.justify('j1', 'X', { evidence: ['e1'] });
  g.justify('j2', 'X', { evidence: ['e2'] });
  const e = g.withdrawEvidence('e1');
  assert.equal(g.state('X'), S.VALID);
  assert.deepEqual(e.changes, []);
  assert.deepEqual(e.degraded, [{ id: 'X', justificationsBefore: 2, justificationsAfter: 1 }]);
  assert.equal(g.support('X').remaining, 1);
  g.withdrawEvidence('e2');
  assert.equal(g.state('X'), S.REASSESS);
});

test('evidence replacement restores support without rewiring', () => {
  const g = chain();
  g.withdrawEvidence('e1');
  assert.equal(g.state('C'), S.REASSESS);
  // e1 already withdrawn: cannot be replaced afterwards
  throwsCode(() => g.replaceEvidence('e1', 'e1b'), 'ALREADY_WITHDRAWN');
  const h = chain();
  const e = h.replaceEvidence('e1', 'e1b', 'recheck');
  assert.deepEqual(e.changes, []);
  assert.equal(h.state('C'), S.VALID);
  assert.deepEqual(h.dependentsOfEvidence('e1b'), ['A', 'B', 'C']);
  h.withdrawEvidence('e1b');
  assert.equal(h.state('C'), S.REASSESS);
});

test('retraction: dependents reassessed, remaining support computed', () => {
  const g = new ValidityEngine();
  g.addEvidence('e1'); g.addEvidence('e2');
  g.addClaim('A'); g.addClaim('B'); g.addClaim('T');
  g.justify('jA', 'A', { evidence: ['e1'] });
  g.justify('jB', 'B', { evidence: ['e2'] });
  g.justify('jT1', 'T', { premises: ['A'] });
  g.justify('jT2', 'T', { premises: ['B'] });
  g.retract('A', 'found wrong');
  assert.equal(g.state('A'), S.RETRACTED);
  assert.equal(g.state('T'), S.VALID); // still supported via B
  g.retract('B');
  assert.equal(g.state('T'), S.REASSESS);
  throwsCode(() => g.retract('A'), 'ALREADY_TERMINAL');
});

test('superseded claims: dependents not migrated automatically', () => {
  const g = chain();
  const e = g.supersede('A', 'A2', 'refined A');
  assert.equal(g.state('A'), S.SUPERSEDED);
  assert.equal(g.claims.A.supersededBy, 'A2');
  assert.equal(g.state('A2'), S.UNSUPPORTED);
  assert.equal(g.state('B'), S.REASSESS);
  assert.ok(e.changes.some((c) => c.id === 'B'));
  // explicit re-justification restores B via the successor
  g.justify('jA2', 'A2', { evidence: ['e1'] });
  g.justify('jB2', 'B', { premises: ['A2'] });
  assert.equal(g.state('B'), S.VALID);
  assert.equal(g.state('C'), S.VALID);
  throwsCode(() => g.justify('jX', 'C', { premises: ['A'] }), 'INVALID_DEPENDENCY');
});

test('contradictions coexist without overwriting', () => {
  const g = new ValidityEngine();
  g.addEvidence('e1'); g.addEvidence('e2');
  g.addClaim('H'); g.addClaim('notH');
  g.justify('j1', 'H', { evidence: ['e1'] });
  g.justify('j2', 'notH', { evidence: ['e2'] });
  const e = g.declareContradiction('notH', 'H');
  assert.deepEqual(e.changes, []);
  assert.equal(g.state('H'), S.VALID);
  assert.equal(g.state('notH'), S.VALID);
  assert.deepEqual(g.conflicts(), [{ a: 'H', b: 'notH', status: 'LIVE' }]);
  g.withdrawEvidence('e1');
  assert.deepEqual(g.conflicts()[0].status, 'DORMANT');
  assert.equal(g.state('notH'), S.VALID); // untouched
  throwsCode(() => g.declareContradiction('H', 'notH'), 'DUPLICATE_ID');
  throwsCode(() => g.declareContradiction('H', 'H'), 'INVALID_DEPENDENCY');
});

test('unrelated claims are unaffected', () => {
  const g = chain();
  g.addEvidence('z'); g.addClaim('Z'); g.justify('jZ', 'Z', { evidence: ['z'] });
  const e = g.withdrawEvidence('e1');
  assert.ok(!e.changes.some((c) => c.id === 'Z'));
  assert.equal(g.state('Z'), S.VALID);
});

test('invalid dependencies are rejected, logged, and change nothing', () => {
  const g = chain();
  const before = JSON.stringify([g.claims, g.justs]);
  throwsCode(() => g.justify('j', 'C', { premises: ['ghost'] }), 'UNKNOWN_CLAIM');
  throwsCode(() => g.justify('j', 'ghost', { premises: ['A'] }), 'UNKNOWN_CLAIM');
  throwsCode(() => g.justify('j', 'C', { evidence: ['ghost'] }), 'UNKNOWN_EVIDENCE');
  throwsCode(() => g.justify('j', 'C', {}), 'EMPTY_JUSTIFICATION');
  throwsCode(() => g.justify('jA', 'C', { premises: ['A'] }), 'DUPLICATE_ID');
  throwsCode(() => g.addClaim('A'), 'DUPLICATE_ID');
  throwsCode(() => g.addClaim(''), 'INVALID_ID');
  throwsCode(() => g.justify('j', 'C', { premises: ['toString'] }), 'UNKNOWN_CLAIM');
  assert.equal(JSON.stringify([g.claims, g.justs]), before);
  const last = g.history.at(-1);
  assert.equal(last.outcome, 'rejected');
  assert.equal(last.error, 'UNKNOWN_CLAIM');
  g.withdrawEvidence('e1');
  throwsCode(() => g.justify('j', 'C', { evidence: ['e1'] }), 'INVALID_DEPENDENCY');
});

test('cycles are rejected, including self and long cycles', () => {
  const g = chain();
  throwsCode(() => g.justify('loop', 'A', { premises: ['C'] }), 'CYCLE');
  throwsCode(() => g.justify('self', 'B', { premises: ['B'] }), 'CYCLE');
  assert.equal(g.state('C'), S.VALID);
  // alternative justification of a non-cyclic shape is still allowed
  g.addClaim('D');
  g.justify('jD', 'D', { premises: ['C'] });
  throwsCode(() => g.justify('back', 'A', { premises: ['D'] }), 'CYCLE');
});

test('history is append-only, ordered, frozen, with explicit changes', () => {
  const g = chain();
  g.withdrawEvidence('e1', 'why');
  const seqs = g.history.map((h) => h.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.ok(Object.isFrozen(g.history[0]));
  const last = g.history.at(-1);
  assert.equal(last.op, 'withdrawEvidence');
  assert.deepEqual(last.args, ['e1', 'why']);
});

test('preview is a dry run with no side effects', () => {
  const g = chain();
  const snap = JSON.stringify(g.snapshot());
  const p = g.preview('withdrawEvidence', 'e1');
  assert.equal(p.rejected, false);
  assert.deepEqual(p.changes.map((c) => c.id), ['A', 'B', 'C']);
  assert.equal(g.preview('retract', 'nope').rejected, true);
  assert.equal(JSON.stringify(g.snapshot()), snap);
});

test('deterministic replay reproduces identical state and history', () => {
  const g = chain();
  g.addEvidence('e2'); g.addClaim('X');
  g.justify('x1', 'X', { evidence: ['e1'] });
  g.justify('x2', 'X', { evidence: ['e2'] });
  try { g.justify('loop', 'A', { premises: ['C'] }); } catch { /* logged rejection */ }
  g.declareContradiction('A', 'X');
  g.withdrawEvidence('e1');
  g.supersede('B', 'B2');
  g.retract('X');
  const r = ValidityEngine.replay(g.history);
  assert.deepEqual(r.snapshot(), g.snapshot());
  // snapshot round trip
  assert.deepEqual(ValidityEngine.fromJSON(g.snapshot()).snapshot(), g.snapshot());
});

test('order of independent operations does not change final validity', () => {
  const build = (order) => {
    const g = new ValidityEngine();
    g.addEvidence('e1'); g.addEvidence('e2');
    g.addClaim('A'); g.addClaim('B'); g.addClaim('C');
    g.justify('jA', 'A', { evidence: ['e1'] });
    g.justify('jB', 'B', { evidence: ['e2'] });
    g.justify('jC', 'C', { premises: ['A', 'B'] });
    for (const e of order) g.withdrawEvidence(e);
    return Object.fromEntries(Object.keys(g.claims).map((k) => [k, g.state(k)]));
  };
  assert.deepEqual(build(['e1', 'e2']), build(['e2', 'e1']));
});

test('long chain recomputes without issue', () => {
  const g = new ValidityEngine();
  g.addEvidence('e'); g.addClaim('n0'); g.justify('j0', 'n0', { evidence: ['e'] });
  for (let i = 1; i < 500; i++) {
    g.addClaim('n' + i);
    g.justify('j' + i, 'n' + i, { premises: ['n' + (i - 1)] });
  }
  assert.equal(g.state('n499'), S.VALID);
  g.withdrawEvidence('e');
  assert.equal(g.state('n499'), S.REASSESS);
});
