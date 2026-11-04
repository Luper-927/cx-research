# E2: Baselines (Split MNIST, class-incremental)

Code: cx001/e2_baselines.py (v2), run by pasting into one Google Colab cell. Setup as E1: MLP 784-256-256-10, SGD lr=0.05, 3 epochs per task, batch 128 (256 for the batch-256 control), replay batch 128, seeds 0-4. EWC: diagonal Fisher from 500 samples per task, summed across tasks, single anchor.
Environment: Python 3.13.18, torch 2.11.0+cpu, torchvision 0.26.0+cpu, numpy 2.4.6, device CPU.
Metrics and std definition: as in E1 (population std over seeds that did not diverge).

| Method | Final acc (mean ± std) | Forgetting (mean ± std) | OK runs |
|---|---|---|---|
| finetune | 0.194 ± 0.001 | 0.990 ± 0.001 | 5/5 |
| finetune_batch256 | 0.193 ± 0.001 | 0.987 ± 0.001 | 5/5 |
| ewc_lam1 | 0.195 ± 0.000 | 0.989 ± 0.001 | 5/5 |
| ewc_lam10 | 0.195 ± 0.000 | 0.989 ± 0.001 | 5/5 |
| ewc_lam100 | 0.194 ± 0.000 | 0.989 ± 0.001 | 5/5 |
| ewc_lam1000 | all runs diverged (loss non-finite) | n/a | 0/5 |
| er_mem500 | 0.834 ± 0.014 | 0.179 ± 0.018 | 5/5 |

Run history: v1 of this script ran EWC at lambda 1000 and 10000 and reported 0.093 ± 0.000. That equals the score of a model that always predicts class 0 (980/(980+1135)/5 = 0.0927), i.e. diverged weights. Those v1 EWC numbers are invalid and discarded. v2 adds divergence detection and a lambda sweep.

Predictions made before the v2 run, all matched: fine-tune, batch-256 and ER-500 reproduce earlier numbers; EWC at 1 and 10 runs and ends near 19-25%; EWC at 1000 diverges.

Findings:
1. ER-500 reproduces E1 to three decimals (0.834 / 0.179), so the pipeline is reproducible.
2. Compute-matched control: fine-tune with batch 256 gives 0.193, so ER's gain on Split MNIST is not explained by seeing more samples per step.
3. EWC is no better than fine-tuning at lambda 1, 10, 100 and diverges at 1000. Consistent with the reported failure of regularisation-only methods in class-incremental learning (to verify against the literature).

Caveats: EWC tuned over lambda only, with one learning rate and one Fisher estimate; the divergence cause (penalty too strong for the learning rate) is consistent with the data but not isolated; MNIST only; hyperparameters untuned for the other methods.
