import { Injectable } from '@nestjs/common';

import type { TaskExecutor, TaskExecutorInput } from '../task-executor';
import { buildSearchResponse } from '../task-executor';
import type { FusedCandidate } from '../../common/types';

@Injectable()
export class TrakeExecutor implements TaskExecutor {
  readonly task = 'trake' as const;
  readonly name = 'trake-retrieval-temporal-viterbi-v1';

  async execute(input: TaskExecutorInput) {
    const numVariants = input.plan.query_variants.length;
    if (numVariants <= 1 || input.candidates.length === 0) {
      return buildSearchResponse(input, this.name, []);
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
        let maxPrevScore = -1;
        let maxPrevIndex = -1;
        // Optimization: since strictly increasing, and array is sorted, 
        // we can just maintain the max valid prefix as we scan i.
        // Wait, multiple candidates might have the SAME original_frame_id.
        // We only transition from strictly smaller frame IDs.
        
        // Two pointers to maintain max score for strictly smaller frame IDs
        let p = 0;
        let runningMaxScore = -1;
        let runningMaxIndex = -1;

        for (let i = 0; i < n; i++) {
          while (p < i && candidates[p].original_frame_id! < candidates[i].original_frame_id!) {
            if (dp[p][v - 1] > runningMaxScore) {
              runningMaxScore = dp[p][v - 1];
              runningMaxIndex = p;
            }
            p++;
          }

          const vScore = candidates[i].variant_scores?.[v] ?? 0;
          if (vScore > 0 && runningMaxScore >= 0) {
            dp[i][v] = runningMaxScore + vScore;
            parent[i][v] = runningMaxIndex;
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
    alignedCandidates.sort((a, b) => b.score - a.score);

    return buildSearchResponse(
      { ...input, candidates: alignedCandidates },
      this.name,
      [],
    );
  }
}
