export const TASK_TYPES = ['textual_kis', 'vqa', 'trake'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const BRANCH_NAMES = [
  'visual',
  'ocr_lexical',
  'ocr_semantic',
  'asr_lexical',
  'asr_semantic',
  'caption',
  'object',
  'temporal',
  'clip',
  'audio',
] as const;
export type BranchName = (typeof BRANCH_NAMES)[number];

export type BranchStatus = 'completed' | 'timed_out' | 'unavailable' | 'failed' | 'skipped_by_plan';

export interface RetrievalOverrides {
  readonly branch_k?: number;
  readonly fusion_k?: number;
  readonly display_k?: number;
}

export interface SearchRequest {
  readonly query: string;
  readonly task: TaskType;
  readonly top_k?: number;
  readonly session_id?: string;
  readonly retrieval?: RetrievalOverrides;
}

export interface RetrievalExecutionPlan {
  readonly query_id: string;
  readonly task: TaskType;
  readonly language: 'vi' | 'en' | 'mixed' | 'unknown';
  readonly original_query: string;
  readonly query_variants: string[];
  readonly concepts: string[];
  readonly text_constraints: string[];
  readonly audio_concepts: string[];
  readonly temporal_relations: Array<'before' | 'after' | 'during' | 'overlaps' | 'near' | 'sequence'>;
  readonly target_granularities: Array<'frame' | 'micro_event' | 'segment' | 'context_window'>;
  readonly branches: BranchName[];
  readonly top_k_per_branch: number;
  readonly fusion_k: number;
  readonly display_k: number;
  readonly latency_budget_ms: number;
  readonly fallback_policy: 'none' | 'expand_then_clarify' | 'expand_then_abstain' | 'clarify_then_abstain';
  readonly planner_version: string;
  readonly fusion: 'rrf';
  readonly index_version: string;
}

export interface BranchCandidate {
  readonly segment_id: string;
  readonly video_id: string;
  readonly rank: number;
  readonly raw_score: number;
  readonly original_frame_id?: number | null;
  readonly start_ms?: number;
  readonly end_ms?: number;
  readonly preview_uri?: string;
  readonly evidence_ids: string[];
  readonly matched_terms?: string[];
}

export interface BranchResult {
  readonly query_id: string;
  readonly branch: BranchName;
  readonly status: BranchStatus;
  readonly query_variant: string | null;
  readonly candidates: BranchCandidate[];
  readonly elapsed_ms: number;
  readonly deadline_ms: number;
  readonly index_version: string;
  readonly producer: string;
  readonly error?: { code: string; message: string; recoverable?: boolean } | null;
}

export interface FusedCandidate {
  readonly segment_id: string;
  readonly video_id: string;
  readonly original_frame_id?: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_uri?: string;
  readonly score: number;
  readonly evidence_ids: string[];
  readonly matched_modalities: string[];
}

export interface SearchResult {
  readonly segment_id: string;
  readonly video_id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_uri: string;
  readonly score: number;
  readonly representative_frame: { original_frame_id: number; timestamp_ms: number; preview_uri: string | null } | null;
  readonly evidence_ids: string[];
  readonly evidence: Array<{ evidence_id: string; type: string; start_ms?: number; end_ms?: number; snippet: string | null; producer: string }>;
  readonly matched_modalities: string[];
}

export interface SearchResponse {
  readonly request_id: string;
  readonly query_id: string;
  readonly query: string;
  readonly session_id: string | null;
  readonly task: TaskType;
  readonly task_executor: string;
  readonly dataset_version: string;
  readonly pipeline_version: string;
  readonly schema_version: string;
  readonly index_version: string;
  readonly degraded: boolean;
  readonly unavailable_branches: string[];
  readonly confidence: {
    level: 'high' | 'medium' | 'low' | 'unknown';
    score: number;
    fallbacks_applied: string[];
    action: 'return' | 'expand' | 'clarify' | 'abstain';
  };
  readonly results: SearchResult[];
  readonly timing: Record<string, unknown>;
  readonly warnings: string[];
}
