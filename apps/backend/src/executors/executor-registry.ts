import { Injectable } from '@nestjs/common';
import { immutable, immutableArray } from '../common/immutable';
import { FusedCandidate, TaskType } from '../retrieval/retrieval.types';

export interface ExecutorResult {
  readonly executor: string; readonly results: readonly FusedCandidate[];
  readonly state: 'completed' | 'needs_more_evidence' | 'clarification_available';
}

@Injectable()
export class ExecutorRegistry {
  execute(task: TaskType, candidates: readonly FusedCandidate[], topK: number): ExecutorResult {
    if (task === 'avs') return this.avs(candidates, topK);
    if (task === 'vqa') return this.vqa(candidates, topK);
    if (task === 'kisc') return this.kisc(candidates, topK);
    return immutable({
      executor: task === 'video_kis' ? 'video_kis_v1' : 'textual_kis_v1',
      results: immutableArray(candidates.slice(0, topK)), state: 'completed',
    });
  }

  private avs(candidates: readonly FusedCandidate[], topK: number): ExecutorResult {
    const selected: FusedCandidate[] = [];
    const usedVideos = new Set<string>();
    for (const candidate of candidates) {
      if (!usedVideos.has(candidate.videoId) && selected.length < topK) {
        selected.push(candidate); usedVideos.add(candidate.videoId);
      }
    }
    for (const candidate of candidates) {
      if (selected.length >= topK) break;
      if (!selected.includes(candidate)) selected.push(candidate);
    }
    return immutable({ executor: 'avs_diversity_v1', results: immutableArray(selected), state: 'completed' });
  }

  private vqa(candidates: readonly FusedCandidate[], topK: number): ExecutorResult {
    return immutable({ executor: 'vqa_evidence_v1', results: immutableArray(candidates.slice(0, topK)), state: candidates.length ? 'completed' : 'needs_more_evidence' });
  }

  private kisc(candidates: readonly FusedCandidate[], topK: number): ExecutorResult {
    const state = candidates.length > 1 ? 'clarification_available' : candidates.length ? 'completed' : 'needs_more_evidence';
    return immutable({ executor: 'kisc_refinement_v1', results: immutableArray(candidates.slice(0, topK)), state });
  }
}
