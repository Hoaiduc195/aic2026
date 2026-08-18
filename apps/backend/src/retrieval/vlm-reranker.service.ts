import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, VISION_LANGUAGE_MODEL } from '../common/tokens';
import type { BackendConfig } from '../common/config';
import type { FusedCandidate, FusionTraceEntry, VlmRerankOverrides } from '../common/types';
import type { VisionLanguageModel, VlmRelevanceResult } from '../compute/vlm-vision.client';

interface VlmRerankOutcome {
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
    const enabled = overrides?.enabled ?? this.config.vlmEnabled;
    if (!enabled || !this.vlm.isConfigured || candidates.length === 0) return [...candidates];

    const topK = Math.min(overrides?.top_k ?? this.config.vlmTopK, candidates.length);
    const weight = overrides?.weight ?? this.config.vlmWeight;
    const targetCandidates = candidates.slice(0, topK);
    const remainingCandidates = candidates.slice(topK);
    const concurrency = Math.max(1, this.config.vlmConcurrency);
    const outcomes: VlmRerankOutcome[] = [];

    this.logger.log(`Starting VLM visual rerank for top ${targetCandidates.length} candidates using ${this.vlm.modelName}`);
    for (let index = 0; index < targetCandidates.length; index += concurrency) {
      const chunk = targetCandidates.slice(index, index + concurrency);
      const chunkOutcomes = await Promise.all(chunk.map((candidate) => this.evaluateCandidate(query, candidate, weight)));
      outcomes.push(...chunkOutcomes);
    }

    const rerankedTop = outcomes
      .map(({ candidate, relevance, adjustedScore }) => {
        if (!relevance) return candidate;
        const trace: FusionTraceEntry = {
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
          fusion_trace: [trace, ...candidate.fusion_trace],
        };
      })
      .sort((left, right) => right.score - left.score);

    return [...rerankedTop, ...remainingCandidates];
  }

  private async evaluateCandidate(query: string, candidate: FusedCandidate, weight: number): Promise<VlmRerankOutcome> {
    if (!candidate.preview_uri?.startsWith('http')) return { candidate, adjustedScore: candidate.score };
    try {
      const relevance = await this.vlm.verifyImageRelevance({ query, imageUrl: candidate.preview_uri });
      const delta = (relevance.score - 50) / 50;
      const multiplier = Math.max(0.1, 1 + delta * weight);
      return { candidate, relevance, adjustedScore: candidate.score * multiplier };
    } catch (error) {
      this.logger.warn(`VLM rerank failed for frame ${candidate.video_id}:${candidate.original_frame_id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return { candidate, adjustedScore: candidate.score };
    }
  }
}
