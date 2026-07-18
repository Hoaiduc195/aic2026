import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ExecutorRegistry } from '../executors/executor-registry';
import { QueryPlanner } from '../planner/query-planner';
import { BranchRuntime } from '../retrieval/branch-runtime';
import { groupTemporalCandidates } from '../retrieval/temporal-grouping';
import { BranchName, TaskType } from '../retrieval/retrieval.types';
import { weightedRrf } from '../retrieval/weighted-rrf';
import { SearchRequestDto } from './search.dto';

@Injectable()
export class SearchService {
  constructor(
    private readonly planner: QueryPlanner,
    private readonly branches: BranchRuntime,
    private readonly executors: ExecutorRegistry,
  ) {}

  async search(dto: SearchRequestDto) {
    const started = Date.now();
    const requestId = `req_${randomUUID()}`;
    const queryId = `qry_${randomUUID()}`;
    const versions = activeVersions();
    const planningStarted = Date.now();
    const plan = this.planner.compile({ query: dto.query, task: dto.task as 'auto' | TaskType, topK: dto.top_k, latencyBudgetMs: dto.latency_budget_ms });
    const planningMs = Date.now() - planningStarted;
    const selectedBranches = dto.branch_hints?.length ? dto.branch_hints as BranchName[] : plan.branches;
    const deadline = Math.max(1, Math.min(500, plan.latencyBudgetMs - planningMs - 100));
    const retrievalStarted = Date.now();
    const rawBranchResults = await this.branches.execute(selectedBranches, { variants: plan.queryVariants, topK: plan.topK }, deadline);
    const branchResults = rawBranchResults.map((result) => ({ ...result, candidates: result.candidates.filter((candidate) => {
      if (dto.filters?.video_ids && !dto.filters.video_ids.includes(candidate.videoId)) return false;
      if (dto.filters?.start_ms != null && candidate.endMs <= dto.filters.start_ms) return false;
      if (dto.filters?.end_ms != null && candidate.startMs >= dto.filters.end_ms) return false;
      return true;
    }) }));
    const retrievalMs = Date.now() - retrievalStarted;
    const fusionStarted = Date.now();
    const fused = weightedRrf(branchResults, { visual: 1, ocr_lexical: 1.2, asr_lexical: 1.1 });
    const grouped = groupTemporalCandidates(fused);
    const executed = this.executors.execute(plan.task, grouped, plan.topK);
    const fusionMs = Date.now() - fusionStarted;
    const canonicalBranch = (branch: string) => branch.startsWith('ocr') ? 'ocr' : branch.startsWith('asr') ? 'asr' : branch;
    const unavailable = [...new Set(branchResults.filter((result) => result.status !== 'completed').map((result) => canonicalBranch(result.branch)))];
    return {
      request_id: requestId, query_id: queryId, query: dto.query,
      task: plan.task, executor: executed.executor, versions,
      confidence: executed.results.length ? 0.5 : 0,
      degraded: unavailable.length > 0, unavailable_branches: unavailable,
      branches: branchResults.map((result) => ({
        request_id: requestId, branch: canonicalBranch(result.branch), status: result.status,
        versions, elapsed_ms: result.elapsedMs, deadline_ms: deadline,
        candidates: result.candidates.map((candidate) => ({
          segment_id: candidate.segmentId, video_id: candidate.videoId, rank: candidate.rank,
          score: candidate.rawScore, evidence_ids: candidate.evidenceIds,
        })),
        error: result.status === 'completed' ? null : {
          code: result.errorCode ?? 'BRANCH_UNAVAILABLE',
          message: result.status === 'timed_out' ? 'Branch deadline exceeded' : result.status === 'failed' ? 'Branch execution failed' : 'Branch is not configured',
          recoverable: true,
        },
      })),
      results: executed.results.filter((candidate) => candidate.evidenceIds.length > 0).map((candidate) => ({
        segment_id: candidate.segmentId, video_id: candidate.videoId,
        start_ms: candidate.startMs, end_ms: candidate.endMs, score: candidate.score,
        preview_uri: `${process.env.MEDIA_BASE_URI ?? 'file://artifacts/previews'}/${encodeURIComponent(candidate.segmentId)}.mp4`,
        evidence_ids: candidate.evidenceIds,
        matched_modalities: [...new Set(candidate.matchedBranches.map(canonicalBranch))], versions,
      })),
      timing_ms: { planning: planningMs, retrieval: retrievalMs, fusion: fusionMs, total: Date.now() - started },
    };
  }
}

function activeVersions() {
  const fixture = process.env.AIC_FIXTURE_INDEX_ENABLED !== 'false';
  const required = (name: string, fallback: string) => {
    const value = process.env[name] ?? (fixture ? fallback : '');
    if (!value) throw new ServiceUnavailableException('No coherent active index version is configured');
    return value;
  };
  return {
    dataset_id: required('AIC_DATASET_ID', 'golden-fixture'), dataset_version: required('AIC_DATASET_VERSION', 'fixture-1'),
    pipeline_version: required('AIC_PIPELINE_VERSION', 'offline-mvp-1'), schema_version: '1.0.0',
    index_version: required('AIC_INDEX_VERSION', 'fixture-index-1'), model_revisions: { fixture: '1' }, activation_state: 'active' as const,
  };
}
