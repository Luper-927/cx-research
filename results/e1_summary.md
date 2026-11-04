# E1: Forgetting reproduction and H1 sanity check (Split MNIST, class-incremental)

Code: cx001/e1_forgetting.py (run by pasting it into one Google Colab cell).
Setup: MLP 784-256-256-10, SGD lr=0.05, 3 epochs per task, batch 128, replay batch 128, reservoir buffer, seeds 0-4. Runtime about 3 minutes.
Environment: Google Colab. Device and library versions were not recorded for this run.

Metrics:
- Final accuracy: mean over the 5 tasks of test accuracy after training on task 5 (argmax over all 10 classes, no task hint).
- Forgetting: mean over tasks 1-4 of (best accuracy on that task after it was learned, before the last task, minus its final accuracy).
- Std: population std (ddof=0) over 5 seeds.

| Memory | Final acc (mean ± std) | Forgetting (mean ± std) |
|---|---|---|
| 0 (fine-tune) | 0.194 ± 0.001 | 0.990 ± 0.001 |
| 200 | 0.770 ± 0.014 | 0.261 ± 0.017 |
| 500 | 0.834 ± 0.014 | 0.179 ± 0.018 |
| 2000 | 0.888 ± 0.020 | 0.109 ± 0.026 |

Predictions made before the run: fine-tune about 20% (matched); ER-500 60-80% (actual 83.4%, prediction too low).

Interpretation: consistent with H1 (replay reduces forgetting) on Split MNIST. Success thresholds were not pre-registered for this run and the formal H1 test is on CIFAR-10, so this is a pipeline check only.
Caveats: untuned hyperparameters; ER sees 2x samples per step (compute-matched control pending); one architecture; 5 seeds.

Novelty log, H2 (write policy vs random reservoir), first pass. Based on search snippets and abstracts only; papers not read in full.
- Aljundi thesis chapter (arXiv 1910.02718): gradient-based sample selection beat reservoir on imbalanced disjoint MNIST, buffer 300, by up to about 15 points on one sequence.
- Schedule-Robust Online CL (arXiv 2210.05561): with a fixed feature extractor, exemplar selection > random reservoir > nearest/outlier-to-class-mean selection. This is not high-loss selection, which remains untested here.
- Brignac et al., ICCV Workshops 2023 (arXiv 2308.01895): compares reservoir with alternative buffer-population strategies.
Verdict: write-policy-vs-reservoir is an existing line of work, so H2 is unlikely to be novel as worded. The full novelty protocol is still pending.
