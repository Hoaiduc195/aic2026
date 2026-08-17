export const QUALIFICATION_TASKS = ['textual_kis', 'qa', 'trake'] as const;

export type QualificationTask = (typeof QUALIFICATION_TASKS)[number];

export type SearchTask =
  | 'textual_kis'
  | 'video_kis'
  | 'avs'
  | 'vqa'
  | 'trake'
  | 'kisc';

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
}

export interface SearchEmbeddingConfig {
  base_url: string;
  api_key?: string;
  timeout_ms: number;
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
}

export interface VqaLlmConfig {
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
  original_frame_id: number;
  timestamp_ms: number;
  thumbnail_uri: string;
  start_ms: number;
  end_ms: number;
  score: number;
  evidence: SearchEvidence[];
  matched_modalities: string[];
}

export interface VideoFrame {
  video_id: string;
  keyframe_no: number;
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

export interface VideoPlayback {
  video_id: string;
  playback_uri: string;
  duration_ms: number;
  fps: number;
  mime_type: 'video/mp4' | 'video/webm' | 'video/ogg';
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
