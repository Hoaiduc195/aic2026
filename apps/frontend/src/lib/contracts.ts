export const QUALIFICATION_TASKS = ['textual_kis', 'qa', 'trake'] as const;

export type QualificationTask = (typeof QUALIFICATION_TASKS)[number];

export type SearchTask =
  | 'textual_kis'
  | 'video_kis'
  | 'avs'
  | 'vqa'
  | 'trake'
  | 'kisc';

export type SearchQueryMode = 'text' | 'frame_image' | 'exact_frames';

export type QueryImproverTask = 'textual_kis' | 'vqa' | 'trake';

export const SEARCH_RRF_BRANCHES = [
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

export type SearchRrfBranch = (typeof SEARCH_RRF_BRANCHES)[number];

export type EvidenceType =
  | 'frame'
  | 'ocr'
  | 'asr'
  | 'caption'
  | 'object'
  | 'track'
  | 'audio'
  | 'temporal';

export interface SearchRequest {
  query: string;
  task: SearchTask;
  top_k: number;
  session_id?: string;
  embedding?: SearchEmbeddingConfig;
  retrieval?: SearchRetrievalConfig;
  frame_query?: {
    video_id: string;
    original_frame_id: number;
  };
}

export interface ExactFrameSearchRequest {
  task: SearchTask;
  frames: Array<{ video_id: string; original_frame_id: number }>;
  session_id?: string;
}

export interface QueryImprovementRequest {
  query: string;
  task: QueryImproverTask;
  question?: string;
  events?: readonly string[];
  llm?: VqaLlmConfig;
}

export interface QueryImprovementResponse {
  original_query: string;
  improved_query: string;
  original_question?: string;
  improved_question?: string;
  original_events?: readonly string[];
  improved_events?: readonly string[];
  changed: boolean;
  producer: string;
  model_version: string;
  warning: string | null;
}

export interface SearchEmbeddingConfig {
  base_url: string;
  api_key?: string;
  timeout_ms: number;
}

export interface SearchRetrievalConfig {
  display_k: number;
  branch_k: number;
  fusion_k: number;
  near_frame_window_ms?: number;
  rrf_k?: number;
  channel_weights?: Partial<Record<SearchRrfBranch, number>>;
  vlm_rerank?: VlmRerankConfig;
}

export interface VlmRerankConfig {
  enabled: boolean;
  top_k: number;
  weight: number;
}

export interface RetrievalCandidate {
  rank: number;
  video_id: string;
  original_frame_id: number | null;
  start_ms: number;
  end_ms: number;
  preview_uri?: string;
  score: number;
  evidence_ids: string[];
  matched_modalities: string[];
}

export interface CandidatePage {
  query_id: string;
  total: number;
  limit: number;
  offset: number;
  candidates: RetrievalCandidate[];
}

export interface SearchEvidence {
  evidence_id: string;
  type: EvidenceType;
  start_ms?: number;
  end_ms?: number;
  snippet?: string | null;
  producer: string;
}

export interface SearchResult {
  video_id: string;
  original_frame_id: number | null;
  start_ms: number;
  end_ms: number;
  preview_uri: string;
  score: number;
  representative_frame?: {
    keyframe_no?: number;
    original_frame_id: number;
    timestamp_ms: number;
    preview_uri?: string | null;
  } | null;
  evidence_ids: string[];
  evidence: SearchEvidence[];
  matched_modalities: string[];
}

export interface SearchConfidence {
  level: 'high' | 'medium' | 'low' | 'unknown';
  score: number;
  fallbacks_applied?: string[];
  action?: 'return' | 'expand' | 'clarify' | 'abstain';
}

export interface SearchResponse {
  request_id?: string;
  query_id: string;
  query?: string;
  query_mode?: SearchQueryMode;
  session_id?: string | null;
  task?: SearchTask;
  task_executor?: string;
  dataset_version?: string;
  pipeline_version?: string;
  schema_version?: string;
  index_version?: string;
  degraded: boolean;
  unavailable_branches: string[];
  confidence?: SearchConfidence;
  results: SearchResult[];
  timing?: Record<string, unknown>;
  warnings?: string[];
}

export interface VqaAnswerRequest {
  query_id: string;
  question: string;
  video_id: string;
  original_frame_id: number;
  llm?: VqaLlmConfig;
  vlm?: VqaVlmConfig;
}

export interface VqaLlmConfig {
  base_url: string;
  api_key?: string;
  model: string;
  timeout_ms: number;
  max_tokens: number;
  temperature: number;
}

export interface VqaVlmConfig {
  base_url: string;
  api_key?: string;
  model: string;
  timeout_ms: number;
  max_tokens: number;
  temperature: number;
}

export interface VqaAnswerSuggestion {
  result_id: string;
  query_id: string;
  video_id: string;
  original_frame_id: number;
  timestamp_ms: number;
  answer_status: 'answered' | 'needs_more_evidence' | 'abstained';
  answer: string | null;
  normalized_answer: string | null;
  evidence_ids: string[];
  confidence: {
    level: 'low' | 'medium' | 'high';
    score: number;
  };
  producer: string;
  model_version?: string | null;
  verification?: Record<string, unknown>;
}

export interface FrameCandidate {
  result_key: string;
  video_id: string;
  keyframe_no?: number;
  original_frame_id: number;
  timestamp_ms: number;
  thumbnail_uri: string;
  start_ms: number;
  end_ms: number;
  score: number;
  evidence: SearchEvidence[];
  matched_modalities: string[];
  is_exact_frame?: boolean;
  annotation_source_frame_id?: number | null;
}

export interface VideoFrame {
  video_id: string;
  keyframe_no?: number | null;
  original_frame_id: number;
  timestamp_ms: number;
  thumbnail_uri: string;
  evidence?: SearchEvidence[];
}

export interface VideoFramesResponse {
  video_id: string;
  center_frame_id: number;
  frames: VideoFrame[];
}

export interface StudioCaption {
  evidence_id: string;
  text: string;
  language: string;
  producer: string;
}

export interface StudioOcr {
  evidence_id: string;
  text: string;
  language: string;
  producer: string;
}

export interface StudioObject {
  evidence_id: string;
  label: string;
  confidence: number;
  normalized_bbox: [number, number, number, number] | null;
  producer: string;
}

export interface StudioFrame {
  video_id: string;
  keyframe_no?: number | null;
  original_frame_id: number;
  timestamp_ms: number;
  captions: StudioCaption[];
  ocr?: StudioOcr[];
  objects: StudioObject[];
  thumbnail_uri?: string;
  is_exact_frame?: boolean;
  annotation_source_frame_id?: number | null;
}

export interface StudioAsrSpan {
  evidence_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  language: string;
  producer: string;
}

export interface VideoStudioResponse {
  video: VideoPlayback;
  frames: StudioFrame[];
  asr_spans: StudioAsrSpan[];
}

export interface VideoPlayback {
  video_id: string;
  playback_uri: string;
  duration_ms: number;
  fps: number;
  frame_count?: number | null;
  mime_type: 'video/mp4' | 'video/webm' | 'video/ogg';
}

export interface CanonicalFrameResponse extends StudioFrame {
  thumbnail_uri: string;
  is_exact_frame: true;
  annotation_source_frame_id: number | null;
  asr_spans?: StudioAsrSpan[];
}

export interface QualificationEventInput {
  event_id: string;
  event_ordinal: number;
  description: string;
}

export interface TextualKisAnswer {
  video_id: string;
  frame_id: number;
}

export interface QaAnswer extends TextualKisAnswer {
  answer: string;
}

export interface TrakeAnswer {
  video_id: string;
  frame_ids: number[];
}

export type QualificationAnswer = TextualKisAnswer | QaAnswer | TrakeAnswer;

export interface QualificationSubmission {
  query_id: string;
  task: QualificationTask;
  answers: QualificationAnswer[];
}

export interface SelectionRevision {
  selection_id: string;
  query_id: string;
  revision: number;
  task: QualificationTask;
  answers: QualificationAnswer[];
  note: string | null;
  created_at?: string;
}

export interface SubmissionPreview {
  query_id: string;
  task: QualificationTask;
  answer_count: number;
  answers: QualificationAnswer[];
  csv: string;
  submittable: boolean;
  warnings: string[];
}
