#!/usr/bin/env python3
"""Generate the learned-rerank exponential-gate curve used in Observational_Memory.md.

Plots the Query<->Query similarity weight (weight = clamp(similarity, 0, 1) ** k)
for several exponents k, over the admitted band above the admission threshold.
Cross-platform: depends only on numpy + matplotlib (Agg backend, no display).

Usage:
    python scripts/plot-learned-rerank-curve.py
Writes:
    docs/images/learned-rerank-exponential-curve.png
"""

from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

THRESHOLD = 0.85
KS = [1, 3, 5, 8]
COLORS = {1: "#2563eb", 3: "#db2777", 5: "#16a34a", 8: "#d97706"}

# Repo-root-relative output path (this file lives in scripts/).
OUT = Path(__file__).resolve().parents[1] / "docs" / "images" / "learned-rerank-exponential-curve.png"


def main() -> None:
    fig, ax = plt.subplots(figsize=(8, 5), dpi=160)

    x_full = np.linspace(0, 1, 500)
    x_adm = np.linspace(THRESHOLD, 1, 300)

    for k in KS:
        ax.plot(x_full, np.clip(x_full, 0, 1) ** k, color=COLORS[k], alpha=0.18, lw=1.2)
        label = f"k = {k}" + ("  (linear)" if k == 1 else "")
        ax.plot(x_adm, x_adm ** k, color=COLORS[k], lw=2.6, label=label)

    ax.axvline(THRESHOLD, color="#6b7280", ls="--", lw=1.5)
    ax.text(THRESHOLD + 0.003, 0.04, "admission threshold = 0.85",
            rotation=90, va="bottom", ha="left", fontsize=9, color="#374151")

    ax.axvspan(0, THRESHOLD, color="#fee2e2", alpha=0.45, zorder=0)
    ax.text(THRESHOLD / 2, 0.92, "rejected\n(below threshold)",
            ha="center", va="center", fontsize=9, color="#b91c1c")

    ax.annotate("near-duplicate queries\ncarry almost full weight",
                xy=(0.985, 0.985 ** 8), xytext=(0.70, 0.62),
                fontsize=9, color="#374151",
                arrowprops=dict(arrowstyle="->", color="#6b7280", lw=1.2))

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("Query\u2194Query cosine similarity  (current query vs. past human-ranked query)", fontsize=10)
    ax.set_ylabel("Similarity weight applied to the feedback event\n(weight = similarity$^{\\,k}$)", fontsize=10)
    ax.set_title("Exponential gate: sharper falloff isolates near-duplicate queries",
                 fontsize=11, fontweight="bold")
    ax.legend(title="Exponent (k)", loc="upper left", framealpha=0.9, fontsize=9, title_fontsize=9)
    ax.grid(True, ls=":", alpha=0.4)
    fig.tight_layout()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, bbox_inches="tight")
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
