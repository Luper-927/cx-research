# Validity Engine Semantics

Status: Implemented, Tested (16 automated tests). Not independently validated.

## Model
- Evidence: active or withdrawn. Replacement withdraws the old item and links it to a new one; a justification citing the old item is satisfied by the new one while that is active.
- Claim: has a lifecycle (ACTIVE, RETRACTED, SUPERSEDED) and a computed validity state.
- Justification: one derivation of one claim. It lists premise claims and evidence. ALL of them must hold (conjunction). A claim may have many justifications; they are independent (disjunction).

## States
- VALID: ACTIVE and at least one justification fully holds.
- NEEDS_REASSESSMENT: ACTIVE, has justifications, none currently holds. This is NOT "false". support(id) lists each justification and exactly what is missing.
- UNSUPPORTED: ACTIVE with no justification registered.
- RETRACTED / SUPERSEDED: terminal. Dead claims never satisfy a premise.

## Rules
1. Validity is recomputed deterministically from the whole graph after every applied operation. No LLM, clock or randomness.
2. Losing one of several justifications keeps a claim VALID. The change is reported in `degraded`.
3. Withdrawing evidence or retracting/superseding a claim never marks dependents false; they become NEEDS_REASSESSMENT only if no other justification holds.
4. Supersession does not migrate dependents. Add a new justification citing the successor.
5. Contradictions are recorded pairs. They never alter validity. conflicts() reports LIVE (both VALID) or DORMANT.
6. Rejected operations (unknown ids, duplicate ids, empty justification, dependency on a dead claim or withdrawn evidence, cycle) change nothing and are logged with their error code.

## Audit
- history is append-only; each entry is frozen and holds seq, op, args, outcome, changes (state transitions) and degraded.
- ValidityEngine.replay(history) rebuilds an identical engine, rejections included.
- preview(op, ...args) shows impact on a clone without touching the real engine.

## Queries
state, support, dependencies, dependents, dependentsOfEvidence, conflicts, snapshot.

## Known limits
- History is ordered and replayable but not tamper-evident (no hash chain).
- Recomputation is whole-graph per operation. 500-node chain runs in about 0.4 s total; very large graphs would need incremental recomputation.
- Recursion depth limits very deep chains (thousands).
