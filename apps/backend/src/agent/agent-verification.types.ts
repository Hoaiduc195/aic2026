import type { SearchRequest } from '../common/types';

export interface AgentStartOptions {
  readonly topK: number;
  readonly videoBudget: number;
  readonly frameBatchSize: number;
  readonly scanMode: AgentScanMode;
  readonly temporalWindowSeconds: number;
  readonly temporalMergeGapSeconds: number;
  readonly temporalWindowsPerVideo: number;
  readonly temporalSampleFps: number;
}

export type AgentScanMode = 'sparse' | 'dense' | 'temporal_zoom';

export interface VerificationTemporalFrame {
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly window_id: number;
  readonly window_start_ms: number;
  readonly window_end_ms: number;
}

export interface VerificationVideo {
  readonly video_id: string;
  readonly video_rank: number;
  readonly seed_score: number;
  readonly seed_frames: readonly number[];
  readonly seed_timestamps_ms: readonly number[];
  readonly temporal_frames: readonly VerificationTemporalFrame[];
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
