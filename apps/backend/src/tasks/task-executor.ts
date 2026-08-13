import type {
  BranchResult,
  FusedCandidate,
  RetrievalExecutionPlan,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from '../common/types';
import type { BackendConfig } from '../common/config';
import type { EvidenceView } from '../retrieval/evidence.repository';

export interface TaskExecutorInput {
  readonly request: SearchRequest;
  readonly plan: RetrievalExecutionPlan;
  readonly branchResults: readonly BranchResult[];
  readonly candidates: readonly FusedCandidate[];
  readonly elapsedMs: number;
  readonly config: BackendConfig;
  readonly evidenceById?: ReadonlyMap<string, EvidenceView>;
}

export interface TaskExecutor {
  readonly task: SearchRequest['task'];
  readonly name: string;
  execute(input: TaskExecutorInput): Promise<SearchResponse>;
}

export function toSearchResults(
  candidates: readonly FusedCandidate[],
  displayK: number,
  bucket?: string,
  evidenceById: ReadonlyMap<string, EvidenceView> = new Map(),
): SearchResult[] {
  return candidates.slice(0, displayK).map((candidate) => {
    const startMs = Math.max(candidate.start_ms, 0);
    const endMs = Math.max(candidate.end_ms, startMs + 1);
    const previewUri = candidate.preview_uri ?? `r2://${bucket ?? 'unconfigured'}/videos/${candidate.video_id}.mp4`;
    return {
      segment_id: candidate.segment_id,
      video_id: candidate.video_id,
      start_ms: startMs,
      end_ms: endMs,
      preview_uri: previewUri,
      score: candidate.score,
      representative_frame: candidate.original_frame_id === undefined || candidate.original_frame_id === null
        ? null
        : { original_frame_id: candidate.original_frame_id, timestamp_ms: startMs, preview_uri: null },
      evidence_ids: candidate.evidence_ids,
      evidence: candidate.evidence_ids
        .map((evidenceId) => evidenceById.get(evidenceId))
        .filter((evidence): evidence is EvidenceView => Boolean(evidence)),
      matched_modalities: candidate.matched_modalities,
    };
  });
}

export function buildSearchResponse(
  input: TaskExecutorInput,
  executorName: string,
  warnings: string[],
): SearchResponse {
  const unavailableBranches = input.branchResults
    .filter((result) => result.status !== 'completed')
    .map((result) => result.branch);
  const degraded = unavailableBranches.length > 0;
  const hasResults = input.candidates.length > 0;
  const confidenceScore = hasResults ? Math.min(1, input.candidates[0].score * 10) : 0;

  return {
    request_id: input.plan.query_id,
    query_id: input.plan.query_id,
    query: input.request.query,
    session_id: input.request.session_id ?? null,
    task: input.request.task,
    task_executor: executorName,
    dataset_version: input.config.datasetVersion,
    pipeline_version: input.config.pipelineVersion,
    schema_version: input.config.schemaVersion,
    index_version: input.config.indexVersion,
    degraded,
    unavailable_branches: unavailableBranches,
    confidence: {
      level: hasResults ? (degraded ? 'low' : 'medium') : 'unknown',
      score: confidenceScore,
      fallbacks_applied: degraded ? ['continue_with_available_branches'] : [],
      action: hasResults ? 'return' : 'expand',
    },
    results: toSearchResults(input.candidates, input.plan.display_k, input.config.r2Bucket, input.evidenceById),
    timing: {
      elapsed_ms: input.elapsedMs,
      branch_status: Object.fromEntries(input.branchResults.map((result) => [result.branch, result.status])),
    },
    warnings,
  };
}
