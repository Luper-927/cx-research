# Pre-registration: CX-001 H1 on Split CIFAR-10

Status: committed BEFORE any CIFAR-10 experiment is run. After the first CIFAR-10 run, this file is never edited; changes are appended as dated amendments at the bottom.

## Hypothesis
H1: a network trained sequentially with an episodic replay buffer (reservoir ER) forgets less than the same network trained sequentially without one. This is already established in the literature; this test validates the CX pipeline on a harder benchmark than Split MNIST.

## Setup (fixed)
- Benchmark: Split CIFAR-10, 5 tasks, classes in label order (0-1, 2-3, 4-5, 6-7, 8-9), class-incremental evaluation (argmax over all 10 classes, no task hint).
- Model: reduced ResNet-18 trained from scratch, no pretraining, no data augmentation, standard per-channel normalisation.
- Optimiser: SGD, no momentum. Batch of new data: 32 (64 for the compute-matched control). ER replay batch: 32. 20 epochs per task.
- Methods: finetune (batch 32); finetune_batch64 (compute-matched control, same samples per step as ER); ER-500 (reservoir buffer, 500 samples); ER-2000 (secondary).
- Hyperparameter tuning: learning rate in {0.01, 0.03, 0.1} for every method, same grid and budget, chosen on a held-out 5,000-image validation split of the training set, single tuning seed (100). The test set is not used for tuning.
- Evaluation: seeds 0-9 on the CIFAR-10 test set. Tuned learning rate used for all seeds.
- Metrics: final average accuracy over the 5 tasks; forgetting = mean over tasks 1-4 of (best accuracy on the task before the last task minus its final accuracy). Definitions as in results/e1_summary.md.

## Success criteria (all three required for "H1 supported")
P1: ER-500 final average accuracy minus finetune is at least 0.10 (10 points), and the lower bound of the 95% CI of the paired difference over 10 seeds (t-distribution) is above 0.
P2: the same, ER-500 versus finetune_batch64.
P3: ER-500 forgetting is at most 0.70 times the finetune forgetting (at least 30% relative reduction).

## If criteria are not met
Do not conclude that H1 is false; it is established. First check for a pipeline bug: finetune should land near 0.19-0.20 (within 3 points); accuracy should rise with buffer size (finetune < ER-500 < ER-2000). Report the outcome either way, including all runs.

## Predictions (before running)
- finetune: 17-22% final accuracy.
- ER-500: roughly 35-50% (from memory of published numbers; to verify, not a reported result).

## Reporting rules
- Report every run, including diverged or failed ones. Diverged runs are counted and listed; statistics are shown both excluding them and treating them as chance accuracy (0.10).
- No threshold, metric or seed set is changed after the first CIFAR-10 run. Any change is a dated amendment with the reason.

## Amendments
(none)
