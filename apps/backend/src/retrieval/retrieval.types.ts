export type BranchName = 'visual' | 'ocr_lexical' | 'asr_lexical';
export type BranchStatus = 'completed' | 'timed_out' | 'unavailable' | 'failed' | 'skipped_by_plan';
export type TaskType = 'textual_kis' | 'video_kis' | 'avs' | 'vqa' | 'kisc';

export interface BranchQuery { readonly variants: readonly string[]; readonly topK: number; }
export interface BranchCandidate {
  readonly segmentId: string; readonly videoId: string;
  readonly startMs: number; readonly endMs: number; readonly rank: number;
  readonly rawScore: number; readonly evidenceIds: readonly string[];
}
export interface BranchResult {
  readonly branch: BranchName; readonly status: BranchStatus;
  readonly elapsedMs: number; readonly candidates: readonly BranchCandidate[];
  readonly errorCode?: string;
}
export interface RetrievalBranch {
  readonly name: BranchName;
  search(query: BranchQuery): Promise<readonly BranchCandidate[]>;
}
export interface FusedCandidate {
  readonly segmentId: string; readonly videoId: string;
  readonly startMs: number; readonly endMs: number; readonly score: number;
  readonly matchedBranches: readonly BranchName[]; readonly evidenceIds: readonly string[];
}
