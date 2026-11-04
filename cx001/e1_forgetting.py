import json, random, sys
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F
from torchvision import datasets

DEV = "cuda" if torch.cuda.is_available() else "cpu"
TASKS = [(0, 1), (2, 3), (4, 5), (6, 7), (8, 9)]
CFG = dict(lr=0.05, epochs=3, batch=128, replay_batch=128,
           mem_sizes=[0, 200, 500, 2000], seeds=[0, 1, 2, 3, 4])


def load():
    f = lambda d: (d.data.float().div(255).view(-1, 784).to(DEV), d.targets.to(DEV))
    return (f(datasets.MNIST("data", train=True, download=True)),
            f(datasets.MNIST("data", train=False, download=True)))


def make_model():
    return nn.Sequential(nn.Linear(784, 256), nn.ReLU(),
                         nn.Linear(256, 256), nn.ReLU(),
                         nn.Linear(256, 10)).to(DEV)


class Reservoir:
    """Fixed-size buffer; every example seen has an equal chance of being kept."""
    def __init__(self, cap):
        self.cap, self.n = cap, 0
        self.x = torch.zeros(cap, 784, device=DEV)
        self.y = torch.zeros(cap, dtype=torch.long, device=DEV)

    def add(self, xb, yb):
        for i in range(len(xb)):
            if self.n < self.cap:
                j = self.n
            else:
                j = random.randint(0, self.n)
                if j >= self.cap:
                    self.n += 1
                    continue
            self.x[j], self.y[j] = xb[i], yb[i]
            self.n += 1

    def sample(self, k):
        idx = torch.randint(0, min(self.n, self.cap), (k,), device=DEV)
        return self.x[idx], self.y[idx]


@torch.no_grad()
def accuracy(model, x, y):
    return (model(x).argmax(1) == y).float().mean().item()


def run(seed, mem, data):
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    (xtr, ytr), (xte, yte) = data
    model = make_model()
    opt = torch.optim.SGD(model.parameters(), lr=CFG["lr"])
    buf = Reservoir(mem) if mem > 0 else None
    R = np.zeros((5, 5))  # R[i, j] = accuracy on task j after training on task i
    for t, cls in enumerate(TASKS):
        m = (ytr == cls[0]) | (ytr == cls[1])
        X, Y = xtr[m], ytr[m]
        for _ in range(CFG["epochs"]):
            perm = torch.randperm(len(X), device=DEV)
            for k in range(0, len(X), CFG["batch"]):
                idx = perm[k:k + CFG["batch"]]
                xb, yb = X[idx], Y[idx]
                loss = F.cross_entropy(model(xb), yb)
                if buf is not None and buf.n > 0:
                    mx, my = buf.sample(CFG["replay_batch"])
                    loss = loss + F.cross_entropy(model(mx), my)
                opt.zero_grad(); loss.backward(); opt.step()
                if buf is not None:
                    buf.add(xb, yb)
        for j, c in enumerate(TASKS):
            mt = (yte == c[0]) | (yte == c[1])
            R[t, j] = accuracy(model, xte[mt], yte[mt])  # class-incremental: argmax over all 10 classes
    forgetting = float(np.mean([R[j:4, j].max() - R[4, j] for j in range(4)]))
    return dict(seed=seed, mem=mem, final_avg_acc=float(R[4].mean()),
                forgetting=forgetting, R=R.tolist())


if __name__ == "__main__":
    data = load()
    out = dict(config=CFG, runs=[])
    for mem in CFG["mem_sizes"]:
        runs = [run(s, mem, data) for s in CFG["seeds"]]
        out["runs"] += runs
        a = np.array([r["final_avg_acc"] for r in runs])
        f = np.array([r["forgetting"] for r in runs])
        print(f"mem={mem:5d}  final_acc={a.mean():.3f}±{a.std():.3f}  forgetting={f.mean():.3f}±{f.std():.3f}")
    json.dump(out, open("e1_results.json", "w"), indent=1)
