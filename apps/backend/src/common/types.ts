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

export interface ObjectQueryConstraints {
  readonly class_filters: string[];
  readonly excluded_classes: string[];
  readonly min_confidence: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly spatial: string[];
}

export interface QueryAtom {
  readonly id: string;
  readonly type: 'visual_concept' | 'visible_text' | 'spoken_text' | 'object' | 'temporal' | 'negative';
  readonly value: string;
  readonly weight: number;
}

export type QueryViews = Partial<Record<BranchName, string>>;
export type ChannelWeights = Partial<Record<BranchName, number>>;

export interface RetrievalOverrides {
  readonly branch_k?: number;
  readonly fusion_k?: number;
  readonly display_k?: number;
  readonly latency_budget_ms?: number;
  readonly rrf_k?: number;
  readonly channel_weights?: ChannelWeights;
  readonly vlm_rerank?: VlmRerankOverrides;
}

export interface VlmRerankOverrides {
  readonly enabled?: boolean;
  readonly top_k?: number;
  readonly weight?: number;
}

export interface EmbeddingRequestConfig {
  readonly base_url: string;
  readonly api_key?: string;
  readonly timeout_ms: number;
}

export interface SearchRequest {
  readonly query: string;
  readonly task: TaskType;
  readonly top_k?: number;
  readonly session_id?: string;
  readonly retrieval?: RetrievalOverrides;
  readonly embedding?: EmbeddingRequestConfig;
}

export interface RetrievalExecutionPlan {
  readonly query_id: string;
  readonly task: TaskType;
  readonly language: 'vi' | 'en' | 'mixed' | 'unknown';
  readonly original_query: string;
  readonly query_variants: string[];
  readonly concepts: string[];
  readonly query_atoms: QueryAtom[];
  readonly negative_concepts: string[];
  readonly text_constraints: string[];
  readonly audio_concepts: string[];
  readonly object_terms: string[];
  readonly object_constraints: ObjectQueryConstraints;
  readonly query_views: QueryViews;
  readonly channel_weights: ChannelWeights;
  readonly temporal_relations: Array<'before' | 'after' | 'during' | 'overlaps' | 'near' | 'sequence'>;
  readonly target_granularities: Array<'frame'>;
  readonly branches: BranchName[];
  readonly top_k_per_branch: number;
  readonly fusion_k: number;
  readonly display_k: number;
  readonly rrf_k: number;
  readonly latency_budget_ms: number;
  readonly fallback_policy: 'none' | 'expand_then_clarify' | 'expand_then_abstain' | 'clarify_then_abstain';
  readonly planner_version: string;
  readonly fusion: 'rrf';
  readonly index_version: string;
  readonly hard_filters: Readonly<Record<string, unknown>>;
  readonly transformations: string[];
}

export interface BranchCandidate {
  readonly video_id: string;
  readonly video_object_key?: string | null;
  readonly rank: number;
  readonly raw_score: number;
  readonly keyframe_no?: number | null;
  readonly original_frame_id?: number | null;
  readonly start_ms?: number;
  readonly end_ms?: number;
  readonly preview_uri?: string;
  readonly evidence_ids: string[];
  readonly matched_terms?: string[];
}

export interface BranchDiagnostics {
  readonly retrieval_mode: string;
  readonly normalized_query: string;
  readonly candidate_count: number;
  readonly scoring_components: string[];
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
  readonly diagnostics?: BranchDiagnostics;
}

export interface FusionTraceEntry {
  readonly branch: BranchName | 'vlm_rerank';
  readonly channel_rank: number;
  readonly channel_weight: number;
  readonly rrf_contribution: number;
  readonly aggregated_raw_score: number;
  readonly occurrence_count: number;
  readonly evidence_ids: string[];
  readonly matched_terms: string[];
  readonly vlm_score?: number;
  readonly vlm_reason?: string;
}

export interface FusedCandidate {
  readonly video_id: string;
  readonly video_object_key?: string | null;
  readonly keyframe_no?: number | null;
  readonly original_frame_id?: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_uri?: string;
  readonly score: number;
  readonly evidence_ids: string[];
  readonly matched_modalities: string[];
  readonly fusion_trace: FusionTraceEntry[];
}

export interface SearchResult {
  readonly video_id: string;
  readonly original_frame_id: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_uri: string;
  readonly score: number;
  readonly representative_frame: {
    keyframe_no?: number;
    original_frame_id: number;
    timestamp_ms: number;
    preview_uri: string | null;
  } | null;
  readonly evidence_ids: string[];
  readonly evidence: Array<{ evidence_id: string; type: string; start_ms?: number; end_ms?: number; snippet: string | null; producer: string }>;
  readonly matched_modalities: string[];
  readonly fusion_trace: FusionTraceEntry[];
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
