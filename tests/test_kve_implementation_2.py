import unittest

from cx_kve_implementation_2 import (
    ClaimStatus, KnowledgeValidityEngine
)


class KveImplementation2Tests(unittest.TestCase):
    def setUp(self):
        self.k = KnowledgeValidityEngine()
        self.e1 = self.k.add_evidence("source A", "source:A")
        self.e2 = self.k.add_evidence("source B", "source:B")

    def test_direct_claim_is_supported_by_evidence(self):
        c = self.k.add_claim("The system is operational", "agent-1")
        self.k.add_derivation(c, evidence_ids=[self.e1], method="source-review")
        self.assertEqual(self.k.status(c), ClaimStatus.SUPPORTED)

    def test_retraction_propagates_as_reassessment(self):
        a = self.k.add_claim("A is true", "agent-1")
        b = self.k.add_claim("B follows from A", "agent-2")
        c = self.k.add_claim("C follows from B", "agent-3")
        self.k.add_derivation(a, evidence_ids=[self.e1])
        self.k.add_derivation(b, premise_ids=[a], evidence_ids=[self.e2])
        self.k.add_derivation(c, premise_ids=[b], evidence_ids=[self.e2])
        self.assertEqual(self.k.status(c), ClaimStatus.SUPPORTED)
        self.k.retract_claim(a, "source withdrawn")
        self.assertEqual(self.k.status(a), ClaimStatus.RETRACTED)
        self.assertEqual(self.k.status(b), ClaimStatus.REASSESSMENT)
        self.assertEqual(self.k.status(c), ClaimStatus.REASSESSMENT)

    def test_alternative_derivation_preserves_support(self):
        a = self.k.add_claim("A", "agent")
        b = self.k.add_claim("B", "agent")
        conclusion = self.k.add_claim("A or B supports C", "agent")
        self.k.add_derivation(a, evidence_ids=[self.e1])
        self.k.add_derivation(b, evidence_ids=[self.e2])
        self.k.add_derivation(conclusion, premise_ids=[a])
        self.k.add_derivation(conclusion, premise_ids=[b])
        self.k.retract_claim(a, "A disproved")
        self.assertEqual(self.k.status(conclusion), ClaimStatus.SUPPORTED)

    def test_revoked_evidence_triggers_reassessment(self):
        c = self.k.add_claim("Claim", "agent")
        self.k.add_derivation(c, evidence_ids=[self.e1])
        self.k.set_evidence_active(self.e1, False)
        self.assertEqual(self.k.status(c), ClaimStatus.REASSESSMENT)

    def test_conflicting_claims_coexist(self):
        yes = self.k.add_claim("Door is open", "agent-A")
        no = self.k.add_claim("Door is closed", "agent-B")
        self.k.add_derivation(yes, evidence_ids=[self.e1])
        self.k.add_derivation(no, evidence_ids=[self.e2])
        self.assertEqual(self.k.status(yes), ClaimStatus.SUPPORTED)
        self.assertEqual(self.k.status(no), ClaimStatus.SUPPORTED)
        self.assertNotEqual(yes, no)

    def test_cycles_are_rejected(self):
        a = self.k.add_claim("A", "agent")
        b = self.k.add_claim("B", "agent")
        self.k.add_derivation(b, premise_ids=[a])
        with self.assertRaises(ValueError):
            self.k.add_derivation(a, premise_ids=[b])

    def test_event_chain_verifies(self):
        c = self.k.add_claim("Claim", "agent")
        self.k.add_derivation(c, evidence_ids=[self.e1])
        self.k.retract_claim(c, "withdrawn")
        self.assertTrue(self.k.verify_ledger())

    def test_explanation_identifies_failed_premise(self):
        a = self.k.add_claim("A", "agent")
        b = self.k.add_claim("B", "agent")
        self.k.add_derivation(a, evidence_ids=[self.e1])
        self.k.add_derivation(b, premise_ids=[a])
        self.k.retract_claim(a, "withdrawn")
        report = self.k.explain(b)
        self.assertEqual(report["status"], "reassessment_required")
        self.assertEqual(
            report["derivations"][0]["non_supported_premises"][0]["claim_id"], a
        )


if __name__ == "__main__":
    unittest.main()
