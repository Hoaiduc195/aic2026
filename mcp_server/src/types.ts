export const TASK_TYPES = ['textual_kis', 'vqa', 'trake'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface FrameRef {
  readonly videoId: string;
  readonly originalFrameId?: number;
  readonly keyframeNo?: number;
}

export interface EmbeddingConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
}

export interface SearchFramesInput {
  readonly query: string;
  readonly task: TaskType;
  readonly topK: number;
  readonly frameQuery?: FrameRef;
  readonly retrieval?: Record<string, unknown>;
  readonly sessionId?: string;
}

export type PlanSearchInput = SearchFramesInput;

export interface VqaAnswerInput {
  readonly queryId: string;
  readonly question: string;
  readonly frame: FrameRef;
}

export interface CandidatePageInput {
  readonly queryId: string;
  readonly limit: number;
  readonly offset: number;
}

export type SubmissionAnswerInput =
  | { readonly videoId: string; readonly frameId: number }
  | { readonly videoId: string; readonly frameId: number; readonly answer: string }
  | { readonly videoId: string; readonly frameIds: readonly number[] };

export interface SubmissionPreviewInput {
  readonly queryId: string;
  readonly task: TaskType;
  readonly answers: readonly SubmissionAnswerInput[];
}

export interface ExactFrameSearchInput {
  readonly task: TaskType;
  readonly frames: readonly FrameRef[];
  readonly sessionId?: string;
}

export interface BackendEvidence {
  readonly evidence_id: string;
  readonly type: string;
  readonly start_ms?: number;
  readonly end_ms?: number;
  readonly snippet?: string | null;
  readonly producer: string;
}

export interface BackendSearchResult {
  readonly video_id: string;
  readonly original_frame_id: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_uri: string;
  readonly score: number;
  readonly representative_frame?: {
    readonly keyframe_no?: number;
    readonly original_frame_id: number;
    readonly timestamp_ms: number;
    readonly preview_uri?: string | null;
  } | null;
  readonly evidence_ids: string[];
  readonly evidence: BackendEvidence[];
  readonly matched_modalities: string[];
}

export interface BackendSearchResponse {
  readonly request_id?: string;
  readonly query_id: string;
  readonly confidence?: {
    readonly level: 'high' | 'medium' | 'low' | 'unknown';
    readonly score: number;
    readonly action?: 'return' | 'expand' | 'clarify' | 'abstain';
  };
  readonly results: BackendSearchResult[];
  readonly warnings: string[];
}

export interface BackendFrame {
  readonly video_id: string;
  readonly keyframe_no: number | null;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly captions: readonly BackendCaption[];
  readonly ocr: readonly BackendOcr[];
  readonly objects: readonly BackendObject[];
  readonly thumbnail_uri: string | null;
  readonly is_exact_frame: true;
  readonly annotation_source_frame_id: number | null;
  readonly asr_spans: readonly BackendAsrSpan[];
}

export interface BackendCaption {
  readonly evidence_id: string;
  readonly text: string;
  readonly language: string;
  readonly producer: string;
}

export interface BackendOcr {
  readonly evidence_id: string;
  readonly text: string;
  readonly language: string;
  readonly producer: string;
}

export interface BackendObject {
  readonly evidence_id: string;
  readonly label: string;
  readonly confidence: number;
  readonly normalized_bbox: readonly [number, number, number, number] | null;
  readonly producer: string;
}

export interface BackendAsrSpan {
  readonly evidence_id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly language: string;
  readonly producer: string;
}

export interface BackendVideoPlayback {
  readonly video_id: string;
  readonly playback_uri: string;
  readonly duration_ms: number;
  readonly fps: number;
  readonly frame_count?: number | null;
  readonly mime_type: 'video/mp4' | 'video/webm' | 'video/ogg';
}

export interface BackendVideoFrames {
  readonly video_id: string;
  readonly center_frame_id: number;
  readonly frames: readonly {
    readonly video_id: string;
    readonly keyframe_no: number;
    readonly original_frame_id: number;
    readonly timestamp_ms: number;
    readonly thumbnail_uri: string;
  }[];
}

export interface BackendStudio {
  readonly video: BackendVideoPlayback;
  readonly frames: readonly {
    readonly video_id: string;
    readonly keyframe_no: number;
    readonly original_frame_id: number;
    readonly timestamp_ms: number;
    readonly captions: readonly BackendCaption[];
    readonly ocr: readonly BackendOcr[];
    readonly objects: readonly BackendObject[];
  }[];
  readonly asr_spans: readonly BackendAsrSpan[];
}

export interface BackendQueryAtom {
  readonly id: string;
  readonly type: string;
  readonly value: string;
  readonly weight: number;
}

export interface BackendRetrievalPlan {
  readonly query_id: string;
  readonly task: TaskType;
  readonly language: string;
  readonly original_query: string;
  readonly query_mode?: string;
  readonly frame_query?: { readonly video_id: string; readonly original_frame_id: number };
  readonly query_variants: readonly string[];
  readonly concepts: readonly string[];
  readonly query_atoms: readonly BackendQueryAtom[];
  readonly negative_concepts: readonly string[];
  readonly text_constraints: readonly string[];
  readonly audio_concepts: readonly string[];
  readonly object_terms: readonly string[];
  readonly object_constraints: Readonly<Record<string, unknown>>;
  readonly query_views: Readonly<Record<string, string>>;
  readonly channel_weights: Readonly<Record<string, number>>;
  readonly temporal_relations: readonly string[];
  readonly target_granularities: readonly string[];
  readonly branches: readonly string[];
  readonly top_k_per_branch: number;
  readonly fusion_k: number;
  readonly display_k: number;
  readonly near_frame_window_ms?: number;
  readonly rrf_k: number;
  readonly latency_budget_ms: number;
  readonly fallback_policy: string;
  readonly planner_version: string;
  readonly fusion: string;
  readonly index_version: string;
  readonly hard_filters: Readonly<Record<string, unknown>>;
  readonly transformations: readonly string[];
}

export type BackendVqaAnswerStatus = 'answered' | 'needs_more_evidence' | 'abstained';

export interface BackendVqaAnswer {
  readonly result_id: string;
  readonly query_id: string;
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly answer_status: BackendVqaAnswerStatus;
  readonly answer: string | null;
  readonly normalized_answer: string | null;
  readonly evidence_ids: readonly string[];
  readonly confidence: { readonly level: 'low' | 'medium' | 'high'; readonly score: number };
  readonly producer: string;
  readonly model_version: string;
  readonly verification?: Readonly<Record<string, unknown>>;
}

export interface BackendCandidate {
  readonly rank: number;
  readonly video_id: string;
  readonly original_frame_id: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_uri?: string;
  readonly score: number;
  readonly evidence_ids: readonly string[];
  readonly matched_modalities: readonly string[];
  readonly fusion_trace: readonly Record<string, unknown>[];
}

export interface BackendCandidatePage {
  readonly query_id: string;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly candidates: readonly BackendCandidate[];
}

export interface BackendSelection {
  readonly selection_id: string;
  readonly query_id: string;
  readonly revision: number;
  readonly task: TaskType;
  readonly answers: readonly Record<string, unknown>[];
  readonly note: string | null;
  readonly created_at: string;
}

export interface BackendSubmissionPreview {
  readonly query_id: string;
  readonly task: TaskType;
  readonly answer_count: number;
  readonly answers: readonly Record<string, unknown>[];
  readonly csv: string;
  readonly submittable: boolean;
  readonly warnings: readonly string[];
}

export interface BackendHealth {
  readonly status: string;
  readonly service: string;
  readonly mode: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly retrieval_branches: readonly string[];
  readonly task_executors: readonly string[];
}

export interface FrameImage {
  readonly bytes: Buffer;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface BackendClientPort {
  searchFrames(input: SearchFramesInput): Promise<BackendSearchResponse>;
  planSearch(input: PlanSearchInput): Promise<BackendRetrievalPlan>;
  searchExactFrames(input: ExactFrameSearchInput): Promise<BackendSearchResponse>;
  getFrame(ref: FrameRef): Promise<BackendFrame>;
  getFrameImage(ref: FrameRef): Promise<FrameImage>;
  getNearbyFrames(videoId: string, centerFrameId: number, limit: number): Promise<BackendVideoFrames>;
  getVideo(videoId: string): Promise<BackendVideoPlayback>;
  getStudio(videoId: string): Promise<BackendStudio>;
  getVqaAnswer(input: VqaAnswerInput): Promise<BackendVqaAnswer>;
  getCandidates(input: CandidatePageInput): Promise<BackendCandidatePage>;
  getSelection(queryId: string): Promise<BackendSelection | null>;
  previewSubmission(input: SubmissionPreviewInput): Promise<BackendSubmissionPreview>;
  getHealth(): Promise<BackendHealth>;
}

export interface RankedFrame {
  readonly videoId: string;
  readonly originalFrameId: number;
  readonly keyframeNo?: number;
  readonly score: number;
  readonly sourceRank: number;
  readonly rank: number;
}

export interface ToolCallTrace {
  readonly tool: string;
  readonly status: 'ok' | 'error';
  readonly durationMs: number;
  readonly error?: string;
}

export interface FrameEvidenceSummary {
  readonly videoId: string;
  readonly originalFrameId: number;
  readonly keyframeNo: number | null;
  readonly timestampMs: number;
  readonly thumbnailUri: string | null;
  readonly captions: string[];
  readonly ocr: string[];
  readonly objects: string[];
  readonly asr: string[];
  readonly evidenceIds: string[];
}

export interface TraceAnswerInput {
  readonly query: string;
  readonly task: TaskType;
  readonly maxResults?: number;
  readonly includeNearby?: boolean;
  readonly candidateFrames?: readonly FrameRef[];
}

export interface TraceAnswerReport {
  readonly traceId: string;
  readonly queryId: string | null;
  readonly query: string;
  readonly verdict: 'supported' | 'uncertain' | 'insufficient';
  readonly confidence: number;
  readonly supportingFrames: FrameRef[];
  readonly relatedFrames: FrameRef[];
  readonly evidence: FrameEvidenceSummary[];
  readonly missingEvidence: string[];
  readonly warnings: string[];
  readonly toolCalls: ToolCallTrace[];
}

export interface SearchLoopInput {
  readonly sessionId?: string;
  readonly task: TaskType;
  readonly query: string;
  readonly question?: string;
  readonly events?: readonly string[];
  readonly seedFrames?: readonly FrameRef[];
  readonly maxIterations?: number;
  readonly maxToolCalls?: number;
  readonly timeBudgetMs?: number;
  readonly targetConfidence?: number;
  readonly includeImages?: boolean;
}

export type SearchLoopStatus = 'supported' | 'uncertain' | 'insufficient' | 'budget_exhausted';

export interface TrakeCoverageReport {
  readonly requiredEvents: readonly string[];
  readonly coveredEvents: readonly number[];
  readonly missingEvents: readonly number[];
  readonly selectedFrames: readonly FrameRef[];
  readonly chronological: boolean;
  readonly videoId?: string;
}

export interface SearchLoopReport {
  readonly sessionId: string;
  readonly status: SearchLoopStatus;
  readonly stopReason: string;
  readonly iterations: number;
  readonly toolCalls: readonly ToolCallTrace[];
  readonly originalQuery: string;
  readonly improvedQuery: string;
  readonly improvedQuestion?: string;
  readonly plan?: BackendRetrievalPlan;
  readonly results: readonly BackendSearchResult[];
  readonly rankedFrames: readonly RankedFrame[];
  readonly evidence: readonly FrameEvidenceSummary[];
  readonly nearbyFrames: readonly FrameRef[];
  readonly images: readonly {
    readonly videoId: string;
    readonly originalFrameId: number;
    readonly mimeType: string;
    readonly bytes: number;
  }[];
  readonly candidates?: BackendCandidatePage;
  readonly vqa?: BackendVqaAnswer;
  readonly trake?: TrakeCoverageReport;
  readonly confidence: number;
  readonly warnings: readonly string[];
}
