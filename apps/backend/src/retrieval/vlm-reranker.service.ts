import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, VISION_LANGUAGE_MODEL } from '../common/tokens';
import type { BackendConfig } from '../common/config';
import type { FusedCandidate, FusionTraceEntry, VlmRerankOverrides } from '../common/types';
import type { VisionLanguageModel, VlmRelevanceResult } from '../compute/vlm-vision.client';

export interface VlmRerankOutcome {
  readonly candidate: FusedCandidate;
  readonly relevance?: VlmRelevanceResult;
  readonly adjustedScore: number;
}

@Injectable()
export class VlmRerankerService {
  private readonly logger = new Logger(VlmRerankerService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: BackendConfig,
    @Inject(VISION_LANGUAGE_MODEL) private readonly vlm: VisionLanguageModel,
  ) {}

  async rerank(
    query: string,
    candidates: readonly FusedCandidate[],
    overrides?: VlmRerankOverrides,
  ): Promise<FusedCandidate[]> {
    const isEnabled = overrides?.enabled ?? this.config.vlmEnabled;
    if (!isEnabled || !this.vlm.isConfigured || candidates.length === 0) {
      return [...candidates];
    }

    // Plan C: adaptive top_k -- scale based on RRF score spread
    const configTopK = overrides?.top_k ?? this.config.vlmTopK;
    const effectiveTopK = this.config.vlmAdaptiveTopK
      ? this.adaptiveTopK(candidates, configTopK)
      : configTopK;

    const topK = Math.min(effectiveTopK, candidates.length);
    const weight = overrides?.weight ?? this.config.vlmWeight;
    const targetCandidates = candidates.slice(0, topK);
    const remainingCandidates = candidates.slice(topK);

    this.logger.log(
      'Starting VLM visual rerank for top ' + targetCandidates.length + ' candidates' +
        (this.config.vlmAdaptiveTopK ? ' (adaptive, base=' + configTopK + ')' : '') +
        ' using ' + this.vlm.modelName,
    );

    const poolLimit = this.config.vlmConcurrency || 4;
    const outcomes: VlmRerankOutcome[] = [];

    const chunks: FusedCandidate[][] = [];
    for (let i = 0; i < targetCandidates.length; i += poolLimit) {
      chunks.push(targetCandidates.slice(i, i + poolLimit));
    }

    for (const chunk of chunks) {
      const chunkOutcomes = await Promise.all(
        chunk.map(async (candidate) => this.evaluateCandidate(query, candidate, weight)),
      );
      outcomes.push(...chunkOutcomes);
    }

    const rerankedTop = outcomes
      .map((outcome) => {
        const { candidate, relevance, adjustedScore } = outcome;
        if (!relevance) return candidate;

        const vlmTrace: FusionTraceEntry = {
          branch: 'vlm_rerank',
          channel_rank: 1,
          channel_weight: weight,
          rrf_contribution: adjustedScore - candidate.score,
          aggregated_raw_score: relevance.score,
          occurrence_count: 1,
          evidence_ids: [...candidate.evidence_ids],
          matched_terms: [relevance.reason],
          vlm_score: relevance.score,
          vlm_reason: relevance.reason,
        };

        return {
          ...candidate,
          score: adjustedScore,
          matched_modalities: [...new Set([...candidate.matched_modalities, 'vlm_rerank'])],
          fusion_trace: [vlmTrace, ...candidate.fusion_trace],
        };
      })
      .sort((a, b) => b.score - a.score);

    // Plan A: hard-filter candidates with VLM score below minimum threshold
    const minScore = overrides?.vlm_min_score ?? this.config.vlmMinScore;
    const filteredTop = minScore > 0
      ? rerankedTop.filter((candidate) => {
          const vlmScore = candidate.fusion_trace.find((t) => t.branch === 'vlm_rerank')?.vlm_score;
          return vlmScore === undefined || vlmScore >= minScore;
        })
      : rerankedTop;

    if (minScore > 0 && filteredTop.length < rerankedTop.length) {
      this.logger.log(
        'VLM filter: removed ' + (rerankedTop.length - filteredTop.length) + ' candidates ' +
          'with score < ' + minScore + ' (kept ' + filteredTop.length + '/' + rerankedTop.length + ')',
      );
    }

    return [...filteredTop, ...remainingCandidates];
  }

  /**
   * Plan C: Adaptive top-K
   * CV (coefficient of variation) = stddev / mean of top-N scores.
   * High CV -> scores spread wide -> top frames clearly better -> fewer VLM calls needed.
   * Low CV  -> scores tightly clustered -> many frames compete -> more VLM calls needed.
   */
  private adaptiveTopK(candidates: readonly FusedCandidate[], baseTopK: number): number {
    const sampleSize = Math.min(candidates.length, baseTopK * 2);
    const scores = candidates.slice(0, sampleSize).map((c) => c.score);
    if (scores.length < 2) return baseTopK;

    const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    if (mean === 0) return baseTopK;

    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
    const cv = Math.sqrt(variance) / mean;

    const scale = 1 + (0.3 - cv) * 2;
    const adaptive = Math.round(baseTopK * Math.max(0.5, Math.min(2, scale)));

    this.logger.debug('Adaptive top-K: base=' + baseTopK + ', cv=' + cv.toFixed(3) + ', effective=' + adaptive);
    return adaptive;
  }

  private async evaluateCandidate(
    query: string,
    candidate: FusedCandidate,
    weight: number,
  ): Promise<VlmRerankOutcome> {
    if (!candidate.preview_uri || !candidate.preview_uri.startsWith('http')) {
      return { candidate, adjustedScore: candidate.score };
    }

    try {
      const relevance = await this.vlm.verifyImageRelevance({
        query,
        imageUrl: candidate.preview_uri,
      });

      const delta = (relevance.score - 50) / 50;
      const multiplier = Math.max(0.1, 1 + delta * weight);
      const adjustedScore = candidate.score * multiplier;

      return { candidate, relevance, adjustedScore };
    } catch (error) {
      this.logger.warn(
        'VLM rerank failed for frame ' + candidate.video_id + ':' + candidate.original_frame_id + ': ' +
          (error instanceof Error ? error.message : 'unknown error'),
      );
      return { candidate, adjustedScore: candidate.score };
    }
  }
}