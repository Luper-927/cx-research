"""
Project CX — Knowledge Validity Engine, Implementation 2
Standalone deterministic prototype; Python 3.10+, standard library only.

Purpose:
- Preserve multiple claims and conflicting claims without overwriting.
- Represent alternative derivations for a claim.
- Recompute support after evidence or premise changes.
- Mark formerly-supported conclusions for reassessment instead of declaring
  them false when their support chain breaks.
- Keep deterministic event records and replayable state transitions.

This is an experimental engine, not yet an Alpha 1 adapter.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from enum import Enum
import hashlib
import json
import threading
import unicodedata
from typing import Any, Iterable


def _normalise(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, (list, tuple)):
        return [_normalise(v) for v in value]
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise TypeError("Canonical JSON object keys must be strings")
        return {
            unicodedata.normalize("NFC", k): _normalise(v)
            for k, v in sorted(value.items(), key=lambda item: item[0])
        }
    raise TypeError(f"Unsupported canonical value: {type(value).__name__}")


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        _normalise(value), ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


class ClaimStatus(str, Enum):
    SUPPORTED = "supported"
    REASSESSMENT = "reassessment_required"
    UNSUPPORTED = "unsupported"
    RETRACTED = "retracted"


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    content_hash: str
    source: str
    description: str


@dataclass(frozen=True)
class Claim:
    claim_id: str
    statement: str
    created_by: str


@dataclass(frozen=True)
class Derivation:
    derivation_id: str
    conclusion_id: str
    premise_ids: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    method: str


@dataclass(frozen=True)
class Event:
    sequence: int
    event_type: str
    payload: dict[str, Any]
    previous_hash: str
    event_hash: str


class KnowledgeValidityEngine:
    """
    In-memory prototype with append-only, hash-chained events.

    A claim is supported when at least one of its derivations has:
      1. every premise currently SUPPORTED; and
      2. every referenced evidence item currently active.

    If a claim was supported and loses all valid derivations, it becomes
    REASSESSMENT rather than being silently marked false. An alternative
    valid derivation keeps it SUPPORTED.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._evidence: dict[str, Evidence] = {}
        self._evidence_active: dict[str, bool] = {}
        self._claims: dict[str, Claim] = {}
        self._derivations: dict[str, Derivation] = {}
        self._by_conclusion: dict[str, list[str]] = {}
        self._status: dict[str, ClaimStatus] = {}
        self._ever_supported: set[str] = set()
        self._events: list[Event] = []
        self._event_head = "0" * 64

    @property
    def events(self) -> tuple[Event, ...]:
        with self._lock:
            return tuple(self._events)

    def _record(self, event_type: str, payload: dict[str, Any]) -> Event:
        sequence = len(self._events) + 1
        body = {
            "sequence": sequence,
            "event_type": event_type,
            "payload": payload,
            "previous_hash": self._event_head,
        }
        event_hash = digest(body)
        event = Event(sequence, event_type, payload, self._event_head, event_hash)
        self._events.append(event)
        self._event_head = event_hash
        return event

    def add_evidence(self, content: bytes | str, source: str,
                     description: str = "") -> str:
        raw = content.encode("utf-8") if isinstance(content, str) else bytes(content)
        content_hash = hashlib.sha256(raw).hexdigest()
        evidence_id = digest({
            "content_hash": content_hash,
            "source": source,
            "description": description,
        })
        with self._lock:
            if evidence_id in self._evidence:
                return evidence_id
            item = Evidence(evidence_id, content_hash, source, description)
            self._evidence[evidence_id] = item
            self._evidence_active[evidence_id] = True
            self._record("evidence.added", asdict(item))
            self._recompute()
        return evidence_id

    def set_evidence_active(self, evidence_id: str, active: bool) -> None:
        with self._lock:
            self._require(self._evidence, evidence_id, "evidence")
            active = bool(active)
            if self._evidence_active[evidence_id] == active:
                return
            self._evidence_active[evidence_id] = active
            self._record("evidence.activation_changed", {
                "evidence_id": evidence_id, "active": active
            })
            self._recompute()

    def add_claim(self, statement: str, created_by: str) -> str:
        statement = unicodedata.normalize("NFC", statement.strip())
        if not statement:
            raise ValueError("Claim statement cannot be empty")
        claim_id = digest({"statement": statement, "created_by": created_by})
        with self._lock:
            if claim_id in self._claims:
                return claim_id
            item = Claim(claim_id, statement, created_by)
            self._claims[claim_id] = item
            self._by_conclusion[claim_id] = []
            self._status[claim_id] = ClaimStatus.UNSUPPORTED
            self._record("claim.added", asdict(item))
        return claim_id

    def add_derivation(self, conclusion_id: str,
                       premise_ids: Iterable[str] = (),
                       evidence_ids: Iterable[str] = (),
                       method: str = "unspecified") -> str:
        premises = tuple(sorted(set(premise_ids)))
        evidence = tuple(sorted(set(evidence_ids)))
        with self._lock:
            self._require(self._claims, conclusion_id, "conclusion claim")
            for pid in premises:
                self._require(self._claims, pid, "premise claim")
            for eid in evidence:
                self._require(self._evidence, eid, "evidence")
            if conclusion_id in premises:
                raise ValueError("A claim cannot directly depend on itself")
            derivation_id = digest({
                "conclusion_id": conclusion_id,
                "premise_ids": premises,
                "evidence_ids": evidence,
                "method": method,
            })
            if derivation_id in self._derivations:
                return derivation_id
            candidate = Derivation(
                derivation_id, conclusion_id, premises, evidence, method
            )
            self._assert_acyclic(candidate)
            self._derivations[derivation_id] = candidate
            self._by_conclusion[conclusion_id].append(derivation_id)
            self._record("derivation.added", {
                "derivation_id": derivation_id,
                "conclusion_id": conclusion_id,
                "premise_ids": list(premises),
                "evidence_ids": list(evidence),
                "method": method,
            })
            self._recompute()
            return derivation_id

    def retract_claim(self, claim_id: str, reason: str) -> None:
        with self._lock:
            self._require(self._claims, claim_id, "claim")
            if self._status[claim_id] == ClaimStatus.RETRACTED:
                return
            self._record("claim.retracted", {"claim_id": claim_id, "reason": reason})
            self._status[claim_id] = ClaimStatus.RETRACTED
            self._recompute()

    def reinstate_claim(self, claim_id: str, reason: str) -> None:
        with self._lock:
            self._require(self._claims, claim_id, "claim")
            if self._status[claim_id] != ClaimStatus.RETRACTED:
                return
            self._record("claim.reinstated", {"claim_id": claim_id, "reason": reason})
            self._status[claim_id] = ClaimStatus.UNSUPPORTED
            self._recompute()

    def status(self, claim_id: str) -> ClaimStatus:
        with self._lock:
            self._require(self._claims, claim_id, "claim")
            return self._status[claim_id]

    def explain(self, claim_id: str) -> dict[str, Any]:
        with self._lock:
            self._require(self._claims, claim_id, "claim")
            derivations = []
            for did in self._by_conclusion[claim_id]:
                d = self._derivations[did]
                inactive_evidence = [
                    eid for eid in d.evidence_ids
                    if not self._evidence_active[eid]
                ]
                non_supported_premises = [
                    {"claim_id": pid, "status": self._status[pid].value}
                    for pid in d.premise_ids
                    if self._status[pid] != ClaimStatus.SUPPORTED
                ]
                derivations.append({
                    "derivation_id": did,
                    "method": d.method,
                    "premises": list(d.premise_ids),
                    "evidence": list(d.evidence_ids),
                    "inactive_evidence": inactive_evidence,
                    "non_supported_premises": non_supported_premises,
                    "currently_valid": not inactive_evidence and not non_supported_premises,
                })
            return {
                "claim_id": claim_id,
                "statement": self._claims[claim_id].statement,
                "status": self._status[claim_id].value,
                "derivations": derivations,
            }

    def reassessment_report(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                self.explain(cid)
                for cid in sorted(self._claims)
                if self._status[cid] == ClaimStatus.REASSESSMENT
            ]

    def verify_ledger(self) -> bool:
        with self._lock:
            previous = "0" * 64
            for index, event in enumerate(self._events, start=1):
                if event.sequence != index or event.previous_hash != previous:
                    return False
                body = {
                    "sequence": event.sequence,
                    "event_type": event.event_type,
                    "payload": event.payload,
                    "previous_hash": event.previous_hash,
                }
                if digest(body) != event.event_hash:
                    return False
                previous = event.event_hash
            return previous == self._event_head

    def export_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "schema": "cx.kve/2",
                "evidence": [
                    {**asdict(v), "active": self._evidence_active[k]}
                    for k, v in sorted(self._evidence.items())
                ],
                "claims": [
                    {**asdict(v), "status": self._status[k].value}
                    for k, v in sorted(self._claims.items())
                ],
                "derivations": [
                    {
                        **asdict(v),
                        "premise_ids": list(v.premise_ids),
                        "evidence_ids": list(v.evidence_ids),
                    }
                    for _, v in sorted(self._derivations.items())
                ],
                "events": [
                    {
                        **asdict(e),
                        "payload": e.payload,
                    } for e in self._events
                ],
            }

    def _recompute(self) -> None:
        # Topological evaluation. Cycles are rejected at insertion time.
        order = self._topological_order()
        for cid in order:
            if self._status.get(cid) == ClaimStatus.RETRACTED:
                continue
            derivation_ids = self._by_conclusion[cid]
            valid = False
            for did in derivation_ids:
                d = self._derivations[did]
                premises_ok = all(
                    self._status[p] == ClaimStatus.SUPPORTED for p in d.premise_ids
                )
                evidence_ok = all(
                    self._evidence_active[e] for e in d.evidence_ids
                )
                if premises_ok and evidence_ok:
                    valid = True
                    break
            if valid:
                self._status[cid] = ClaimStatus.SUPPORTED
                self._ever_supported.add(cid)
            elif cid in self._ever_supported:
                self._status[cid] = ClaimStatus.REASSESSMENT
            else:
                self._status[cid] = ClaimStatus.UNSUPPORTED

    def _topological_order(self) -> list[str]:
        indegree = {cid: 0 for cid in self._claims}
        children: dict[str, set[str]] = {cid: set() for cid in self._claims}
        for d in self._derivations.values():
            for premise in d.premise_ids:
                if d.conclusion_id not in children[premise]:
                    children[premise].add(d.conclusion_id)
                    indegree[d.conclusion_id] += 1
        ready = sorted(cid for cid, degree in indegree.items() if degree == 0)
        result: list[str] = []
        while ready:
            cid = ready.pop(0)
            result.append(cid)
            for child in sorted(children[cid]):
                indegree[child] -= 1
                if indegree[child] == 0:
                    ready.append(child)
                    ready.sort()
        if len(result) != len(self._claims):
            raise ValueError("Dependency graph contains a cycle")
        return result

    def _assert_acyclic(self, candidate: Derivation) -> None:
        # Adding premise -> conclusion edges is illegal if conclusion already
        # reaches any proposed premise.
        adjacency: dict[str, set[str]] = {cid: set() for cid in self._claims}
        for d in self._derivations.values():
            for premise in d.premise_ids:
                adjacency[premise].add(d.conclusion_id)
        stack = [candidate.conclusion_id]
        seen: set[str] = set()
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            if node in candidate.premise_ids:
                raise ValueError("Derivation would create a dependency cycle")
            stack.extend(adjacency[node])

    @staticmethod
    def _require(mapping: dict[str, Any], key: str, label: str) -> None:
        if key not in mapping:
            raise KeyError(f"Unknown {label}: {key}")
