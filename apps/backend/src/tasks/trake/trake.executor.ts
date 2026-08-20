import { Injectable } from '@nestjs/common';

import type { TaskExecutor, TaskExecutorInput } from '../task-executor';
import { buildSearchResponse } from '../task-executor';
import type { FusedCandidate } from '../../common/types';

function temporalTransitionMultiplier(deltaMs: number): number {
  if (deltaMs < 400) {
    return 0.5; // Heavy penalty for frames too close to be distinct narrative events
  }
  if (deltaMs >= 1000 && deltaMs <= 120000) {
    return 1.2; // Reward natural narrative pacing (1s to 2 mins)
  }
  if (deltaMs > 900000) {
    return 0.8; // Mild penalty for excessive jumps (> 15 mins)
  }
  return 1.0;
}

@Injectable()
export class TrakeExecutor implements TaskExecutor {
  readonly task = 'trake' as const;
  readonly name = 'trake-retrieval-temporal-viterbi-v1';

  async execute(input: TaskExecutorInput) {
    const numVariants = input.plan.query_variants.length;
    if (input.candidates.length === 0) {
      return buildSearchResponse(input, this.name, []);
    }
    if (numVariants <= 1) {
      return buildSearchResponse(input, this.name, input.candidates);
    }

    const byVideo = new Map<string, FusedCandidate[]>();
    for (const candidate of input.candidates) {
      if (candidate.original_frame_id == null) continue;
      const group = byVideo.get(candidate.video_id) ?? [];
      group.push(candidate);
      byVideo.set(candidate.video_id, group);
    }

    const alignedCandidates: FusedCandidate[] = [];

    for (const [videoId, candidates] of byVideo.entries()) {
      candidates.sort((a, b) => (a.original_frame_id!) - (b.original_frame_id!));
      const n = candidates.length;
      
      // dp[i][v] = max score for matching variants 0..v ending at candidate i
      const dp = Array.from({ length: n }, () => new Float64Array(numVariants).fill(-1));
      const parent = Array.from({ length: n }, () => new Int32Array(numVariants).fill(-1));

      for (let i = 0; i < n; i++) {
        const vScore = candidates[i].variant_scores?.[0] ?? 0;
        if (vScore > 0) {
          dp[i][0] = vScore;
        }
      }

      for (let v = 1; v < numVariants; v++) {
        for (let i = 0; i < n; i++) {
          const vScore = candidates[i].variant_scores?.[v] ?? 0;
          if (vScore <= 0) continue;

          let bestPrevScore = -1;
          let bestPrevIndex = -1;

          for (let p = 0; p < i; p++) {
            if (candidates[p].original_frame_id! >= candidates[i].original_frame_id!) continue;
            if (dp[p][v - 1] <= 0) continue;

            const prevMs = candidates[p].timestamp_ms ?? (candidates[p].original_frame_id! * 40);
            const currMs = candidates[i].timestamp_ms ?? (candidates[i].original_frame_id! * 40);
            const deltaMs = Math.max(1, currMs - prevMs);
            const transition = temporalTransitionMultiplier(deltaMs);

            const totalScore = dp[p][v - 1] + vScore * transition;
            if (totalScore > bestPrevScore) {
              bestPrevScore = totalScore;
              bestPrevIndex = p;
            }
          }

          if (bestPrevScore > 0 && bestPrevIndex >= 0) {
            dp[i][v] = bestPrevScore;
            parent[i][v] = bestPrevIndex;
          }
        }
      }

      let bestScore = -1;
      let bestEndIndex = -1;
      for (let i = 0; i < n; i++) {
        if (dp[i][numVariants - 1] > bestScore) {
          bestScore = dp[i][numVariants - 1];
          bestEndIndex = i;
        }
      }

      if (bestScore >= 0 && bestEndIndex >= 0) {
        // Reconstruct path
        const path: FusedCandidate[] = [];
        let curr = bestEndIndex;
        for (let v = numVariants - 1; v >= 0; v--) {
          const candidate = candidates[curr];
          // We can assign a boosted score to the aligned candidates
          path.unshift({ ...candidate, score: candidate.score + bestScore / numVariants });
          curr = parent[curr][v];
        }
        alignedCandidates.push(...path);
      }
    }

    // Sort aligned candidates by the new score (descending)
    if (alignedCandidates.length > 0) {
      alignedCandidates.sort((a, b) => b.score - a.score);
      return buildSearchResponse(
        { ...input, candidates: alignedCandidates },
        this.name,
        [],
      );
    }

    return buildSearchResponse(input, this.name, input.candidates);
  }
}
