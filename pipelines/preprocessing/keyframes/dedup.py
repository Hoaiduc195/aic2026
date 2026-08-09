"""Retrieval-lane deduplication with temporal coverage repair.
tier 1 — sequential dHash on CPU (near-identical neighbours),
tier 2 — global within-video cosine on CLIP embeddings (recurring scenes,
         e.g. A->B->A cutbacks that a sequential check misses),
plus a final coverage-repair pass (see enforce_coverage) that guarantees no
gap between consecutive keyframes ever exceeds max_gap_s.

DESIGN NOTE (why dedup and coverage are two separate passes, not one):
An earlier version tried to enforce the gap guarantee *inside* the sequential
merge loops (skip a drop if it would open too wide a gap). That has a subtle
but serious flaw: when the "keep the sharper frame" rule updates the kept
representative in place, the representative's own timestamp can end up
anywhere within its ~max_gap_s window depending on where the locally-sharpest
frame happened to be -- early, late, or in the middle. Two adjacent windows
can independently pick an early representative and a late representative,
and the gap between those two *actual output timestamps* can then approach
2x max_gap_s even though each window's own internal bookkeeping was locally
"correct". Verified by a targeted regression test with non-monotonic quality
scores (tests/test_dedup_coverage.py) before and after this fix.
The robust fix: let dedup be purely a compaction step (drop what's provably
redundant, no gap awareness needed), then run one dedicated repair pass at
the end that looks at *actual* gaps in the final list and backfills the
sharpest available original candidate into any gap that is too wide. This is
easy to reason about because the guarantee is checked directly against the
thing that matters (final output timestamps), not inferred from bookkeeping
that increasingly does not correspond to those timestamps.

This module must never be applied to the dense temporal lane: duplicate source
frames still carry valid event-boundary evidence and exact frame identifiers.
"""

import cv2
import numpy as np


def dhash(rgb: np.ndarray) -> int:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    diff = small[:, 1:] > small[:, :-1]          # 8x8 horizontal gradient signs
    return int.from_bytes(np.packbits(diff.flatten()).tobytes(), "big")


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def phash_dedup(items: list[dict], max_hamming: int = 5) -> list[dict]:
    """Sequential near-duplicate removal, purely a compaction step (no gap
    awareness -- that is enforce_coverage's job, run afterwards on the full
    pipeline output). `items` are time-ordered dicts with 'frame' (RGB) and
    'blur_score'. When two neighbours collide, the sharper one wins."""
    if isinstance(max_hamming, bool) or not isinstance(max_hamming, int) or max_hamming < 0:
        raise ValueError("max_hamming must be a non-negative integer")
    kept: list[dict] = []
    for it in items:
        it["hash"] = dhash(it["frame"])
        if kept and hamming(kept[-1]["hash"], it["hash"]) < max_hamming:
            if it["blur_score"] > kept[-1]["blur_score"]:
                kept[-1] = it
            continue
        kept.append(it)
    return kept


def cosine_dedup(embeddings: np.ndarray, threshold: float) -> list[int]:
    """Global within-video dedup on L2-normalized embeddings, in time order.
    A frame is dropped if it is too similar to ANY frame already kept.
    Purely a compaction step, no gap awareness (see module docstring).
    O(N^2·D) but N is a few hundred per video — negligible next to decoding."""
    kept: list[int] = []
    for i in range(len(embeddings)):
        if kept:
            sims = embeddings[kept] @ embeddings[i]
            if float(sims.max()) > threshold:
                continue
        kept.append(i)
    return kept


def enforce_coverage(all_candidates: list[dict], kept: list[dict], max_gap_s: float,
                     video_start: float, video_end: float) -> list[dict]:
    """Final repair pass: guarantee no gap between consecutive kept keyframes
    (including the video's own start/end boundaries) exceeds max_gap_s, by
    backfilling the sharpest quality-passing candidate available in each
    offending gap. `all_candidates` is the FULL quality-filtered candidate
    list for this video (pre-dedup, so it still has every frame dedup could
    have removed) — this is what makes the repair correct: it can always find
    *something* to fill a gap with, not just what dedup happened to keep.

    Loops because inserting one candidate can still leave a sub-gap too wide
    (e.g. filling a 25s hole once can leave a 15s remainder); each iteration
    strictly shrinks the largest remaining gap, so it terminates.

    A gap with NO candidate available (e.g. an outro title card that failed
    the quality filter, or a stretch with no decoded frames at all) is a real
    hole we cannot fill -- we record it as unresolvable and move on to the
    next-widest gap instead of giving up on the whole video. This matters:
    the widest gap is often precisely the unfillable one (nothing was ever
    kept there), so aborting on it would starve every other, narrower-but-
    still-fixable gap of repair -- which would silently re-open the very
    coverage violation this pass exists to close."""
    if max_gap_s <= 0:
        return kept
    kept = sorted(kept, key=lambda x: x["pts_time"])
    all_sorted = sorted(all_candidates, key=lambda x: x["pts_time"])
    unresolvable: set[tuple[float, float]] = set()  # gap boundaries we know have no candidate
    while True:
        pts = [video_start] + [k["pts_time"] for k in kept] + [video_end]
        gap_idx = None
        widest = max_gap_s
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            if (a, b) in unresolvable:
                continue  # already proven unfillable; don't let it block other gaps
            if b - a > widest + 1e-6:
                widest, gap_idx = b - a, i
        if gap_idx is None:
            break  # every remaining over-wide gap has been marked unresolvable
        a, b = pts[gap_idx], pts[gap_idx + 1]
        window = [c for c in all_sorted if a < c["pts_time"] < b]
        if not window:
            unresolvable.add((a, b))  # real hole -- skip it, keep repairing the rest
            continue
        # prefer a quality-passing candidate; only fall back to a sub-threshold
        # reserve frame (quality_ok=False) when the gap has no better option.
        best = max(window, key=lambda c: (bool(c.get("quality_ok", True)), c["blur_score"]))
        kept.append(best)
        kept.sort(key=lambda x: x["pts_time"])
    return kept
