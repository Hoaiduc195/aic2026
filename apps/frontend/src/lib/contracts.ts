export type Task = 'textual_kis' | 'video_kis' | 'avs' | 'vqa' | 'kisc';

export interface VersionManifest {
  dataset_id: string;
  dataset_version: string;
  pipeline_version: string;
  schema_version: string;
  index_version: string;
  model_revisions: Record<string, string>;
  activation_state: 'staged' | 'active' | 'retired';
}

export interface SearchResult {
  segment_id: string;
  video_id: string;
  start_ms: number;
  end_ms: number;
  preview_uri: string;
  score: number;
  matched_modalities: string[];
  evidence_ids: string[];
  versions: VersionManifest;
}

export interface BranchStatus {
  request_id: string;
  branch: 'visual' | 'ocr' | 'asr' | 'caption' | 'object' | 'audio';
  status: 'completed' | 'timed_out' | 'unavailable' | 'failed';
  elapsed_ms: number;
  deadline_ms: number;
  candidates: Array<{ segment_id: string; video_id: string; rank: number; score: number; evidence_ids: string[] }>;
  versions: VersionManifest;
  error: { code: string; message: string; recoverable: boolean } | null;
}

export interface SearchResponse {
  request_id: string;
  query_id: string;
  query: string;
  task: Task;
  executor: string;
  versions: VersionManifest;
  confidence: number;
  degraded: boolean;
  unavailable_branches: string[];
  branches: BranchStatus[];
  results: SearchResult[];
  timing_ms: { planning: number; retrieval: number; fusion: number; total: number };
}

export interface SearchRequest {
  query: string;
  task: Task;
  top_k: number;
}
