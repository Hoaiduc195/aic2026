import type { SearchRequest } from '../common/types';

export interface AgentStartOptions {
  readonly topK: number;
  readonly videoBudget: number;
  readonly frameBatchSize: number;
}

export interface VerificationVideo {
  readonly video_id: string;
  readonly video_rank: number;
  readonly seed_score: number;
  readonly seed_frames: readonly number[];
  readonly frames_total: number;
}

export interface VerificationPendingBatch {
  readonly video_id: string;
  readonly after_original_frame_id: number;
  readonly frame_ids: readonly number[];
  readonly has_more: boolean;
  readonly next_cursor: number | null;
}

export interface VerificationJudgment {
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly relevant: boolean;
  readonly score: number;
  readonly reason?: string;
}

export type AgentPrefilterRoute = 'auto_reject' | 'auto_accept' | 'vlm_review';

export interface AgentVerificationStartRequest {
  readonly search: SearchRequest;
  readonly options: AgentStartOptions;
}
