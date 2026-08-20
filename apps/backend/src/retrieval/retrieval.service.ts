import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  APP_CONFIG, EMBEDDING_SERVICE, EVIDENCE_REPOSITORY, OBJECT_STORAGE,
  RETRIEVAL_BRANCHES, RETRIEVAL_STORE, TASK_EXECUTOR_REGISTRY, VLM_RERANKER,
} from '../common/tokens';
import type {
  BranchName,
  BranchResult,
  RetrievalExecutionPlan,
  SearchRequest,
  SearchResponse,
} from '../common/types';
import type { BackendConfig } from '../common/config';
import { candidateKey, fuseBranchResults } from './fusion';
import { filterNearbyCandidates } from './temporal-filter';
import type { RetrievalBranch } from './branch';
import { buildDeterministicPlan, queryForBranch } from './query-planner';
import type { TaskExecutorInput } from '../tasks/task-executor';
import { TaskExecutorRegistry } from '../tasks/task-registry';
import type { RetrievalStore } from './retrieval.store';
import type { EvidenceRepository, EvidenceView } from './evidence.repository';
import type { ObjectStorage } from '../storage/object-storage';
import { signPreviewUris, withPreviewReferences } from '../storage/preview-url';
import type { EmbeddingService } from '../embedding_services/embedding.service';
import { MediaService } from '../media/media.service';
import type { VlmRerankerService } from './vlm-reranker.service';

const DEFAULT_BRANCH_K = 100;
const DEFAULT_FUSION_K = 500;
const DEFAULT_DISPLAY_K = 100;
const DEFAULT_RRF_K = 60;

function isDatabaseTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '57014');
}

function timedOutBranch(branch: RetrievalBranch, query: string, plan: RetrievalExecutionPlan): BranchResult {
  return {
    query_id: plan.query_id,
    branch: branch.name,
    status: 'timed_out',
    query_variant: query,
    candidates: [],
    elapsed_ms: plan.latency_budget_ms,
    deadline_ms: plan.latency_budget_ms,
    index_version: plan.index_version,
    producer: 'retrieval-core-timeout',
    error: { code: 'BRANCH_TIMEOUT', message: 'retrieval branch exceeded its deadline', recoverable: true },
  };
}

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: BackendConfig,
    @Inject(RETRIEVAL_BRANCHES) private readonly branches: readonly RetrievalBranch[],
    @Inject(TASK_EXECUTOR_REGISTRY) private readonly executors: TaskExecutorRegistry,
    @Optional() @Inject(RETRIEVAL_STORE) private readonly store?: RetrievalStore,
    @Optional() @Inject(EVIDENCE_REPOSITORY) private readonly evidenceRepository?: EvidenceRepository,
    @Optional() @Inject(OBJECT_STORAGE) private readonly storage?: ObjectStorage,
    @Optional() @Inject(EMBEDDING_SERVICE) private readonly embeddingService?: EmbeddingService,
    @Optional() @Inject(VLM_RERANKER) private readonly vlmReranker?: VlmRerankerService,
    @Optional() @Inject(MediaService) private readonly mediaService?: MediaService,
  ) {}

  createPlan(request: SearchRequest): RetrievalExecutionPlan {
    return this.createPlanForBranches(request, this.resolveBranches(request));
  }

  private createPlanForBranches(
    request: SearchRequest,
    branches: readonly RetrievalBranch[],
  ): RetrievalExecutionPlan {
    const displayK = request.retrieval?.display_k ?? request.top_k ?? DEFAULT_DISPLAY_K;
    const fusionK = Math.max(request.retrieval?.fusion_k ?? DEFAULT_FUSION_K, displayK);
    const branchK = Math.max(request.retrieval?.branch_k ?? DEFAULT_BRANCH_K, fusionK > DEFAULT_FUSION_K ? displayK : 1);
    const plan = buildDeterministicPlan(
      request,
      randomUUID(),
      this.config.indexVersion,
      branches,
      {
        branchK,
        fusionK,
        displayK,
        nearFrameWindowMs: request.retrieval?.near_frame_window_ms ?? 1000,
        latencyBudgetMs: request.retrieval?.latency_budget_ms ?? 5000,
        rrfK: request.retrieval?.rrf_k ?? DEFAULT_RRF_K,
        channelWeights: request.retrieval?.channel_weights,
      },
    );
    this.logger.debug(JSON.stringify({ event: 'query_plan_created', plan }));
    return plan;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const frameEmbedding = await this.resolveFrameQueryEmbedding(request);
    const branches = this.resolveBranches(request, frameEmbedding);
    const plan = this.createPlanForBranches(request, branches);
    const startedAt = performance.now();
    const branchResults = await Promise.all(
      branches
        .filter((branch) => plan.branches.includes(branch.name))
        .map((branch) => this.runBranchVariants(branch, plan)),
    );
    const fusedCandidates = fuseBranchResults(branchResults, plan);
    const persistedReferences = withPreviewReferences(fusedCandidates);
    const warnings: string[] = [];
    let responseCandidates = persistedReferences;
    if (this.storage?.isConfigured) {
      try {
        responseCandidates = await signPreviewUris(persistedReferences, this.storage);
      } catch (error) {
        this.logger.warn(`preview signing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        warnings.push('preview_signing_failed');
      }
    }
    if (this.vlmReranker && !request.frame_query) {
      try {
        responseCandidates = await this.vlmReranker.rerank(
          request.query,
          responseCandidates,
          request.retrieval?.vlm_rerank,
        );
      } catch (error) {
        this.logger.warn(`VLM reranking failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        warnings.push('vlm_reranking_failed');
      }
    }

    const filteredCandidates = filterNearbyCandidates(responseCandidates, plan.near_frame_window_ms ?? 1000);
    const previewByCandidate = new Map(
      persistedReferences.map((candidate) => [
        candidateKey(candidate.video_id, candidate.original_frame_id, candidate.start_ms, candidate.end_ms),
        candidate.preview_uri,
      ]),
    );
    const persistedCandidates = filteredCandidates.map((candidate) => ({
      ...candidate,
      ...(previewByCandidate.get(candidateKey(candidate.video_id, candidate.original_frame_id, candidate.start_ms, candidate.end_ms))
        ? { preview_uri: previewByCandidate.get(candidateKey(candidate.video_id, candidate.original_frame_id, candidate.start_ms, candidate.end_ms)) }
        : {}),
    }));
    responseCandidates = filteredCandidates;

    let evidenceById: ReadonlyMap<string, EvidenceView> = new Map();
    try {
      const evidenceIds = [...new Set(responseCandidates.flatMap((candidate) => candidate.evidence_ids))];
      evidenceById = await this.evidenceRepository?.findByIds(evidenceIds) ?? evidenceById;
    } catch (error) {
      this.logger.warn(`evidence hydration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      warnings.push('evidence_hydration_failed');
    }
    try {
      await this.store?.saveRun(request, plan, persistedCandidates);
    } catch (error) {
      this.logger.warn(`retrieval persistence failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      warnings.push('retrieval_persistence_failed');
    }
    const executor = this.executors.resolve(request.task);
    const input: TaskExecutorInput = {
      request,
      plan,
      branchResults,
      candidates: responseCandidates,
      elapsedMs: Math.round(performance.now() - startedAt),
      config: this.config,
      evidenceById,
    };
    const response = await executor.execute(input);
    return warnings.length > 0
      ? { ...response, warnings: [...response.warnings, ...warnings] }
      : response;
  }

  private resolveBranches(request: SearchRequest, queryEmbedding?: readonly number[]): readonly RetrievalBranch[] {
    return this.embeddingService?.resolveBranches(this.branches, request, queryEmbedding) ?? this.branches;
  }

  private async resolveFrameQueryEmbedding(request: SearchRequest): Promise<readonly number[] | undefined> {
    const frameQuery = request.frame_query;
    if (!frameQuery) return undefined;
    if (!this.embeddingService) {
      throw new ServiceUnavailableException('frame image query embedding is not configured');
    }

    const indexed = await this.embeddingService.findIndexedFrameEmbedding(
      frameQuery.video_id,
      frameQuery.original_frame_id,
      this.config.indexVersion,
    );
    if (indexed) return indexed;
    if (!this.mediaService) {
      throw new ServiceUnavailableException('exact frame image service is not configured');
    }

    const thumbnail = await this.mediaService.getFrameThumbnail(
      frameQuery.video_id,
      frameQuery.original_frame_id,
    );
    return this.embeddingService.embedImage(thumbnail.bytes, thumbnail.mime_type, request);
  }

  private async runBranch(
    branch: RetrievalBranch,
    query: string,
    plan: RetrievalExecutionPlan,
  ): Promise<BranchResult> {
    const startedAt = performance.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();
    try {
      const timeout = new Promise<BranchResult>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({
          ...timedOutBranch(branch, query, plan),
        }), plan.latency_budget_ms);
      });
      const result = await Promise.race([
        branch.search(query, plan, abortController.signal),
        timeout.then((timedOut) => {
          abortController.abort();
          return timedOut;
        }),
      ]);
      return { ...result, elapsed_ms: Math.max(result.elapsed_ms, Math.round(performance.now() - startedAt)) };
    } catch (error) {
      if (abortController.signal.aborted || isDatabaseTimeout(error)) {
        return timedOutBranch(branch, query, plan);
      }
      this.logger.warn(`${branch.name} branch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return {
        query_id: plan.query_id,
        branch: branch.name as BranchName,
        status: 'failed',
        query_variant: query,
        candidates: [],
        elapsed_ms: Math.round(performance.now() - startedAt),
        deadline_ms: plan.latency_budget_ms,
        index_version: plan.index_version,
        producer: 'retrieval-core',
        error: {
          code: 'BRANCH_FAILURE',
          message: 'retrieval branch failed',
          recoverable: true,
        },
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async runBranchVariants(branch: RetrievalBranch, plan: RetrievalExecutionPlan): Promise<BranchResult> {
    const results = await Promise.all(plan.query_variants.map((variant) => (
      this.runBranch(branch, queryForBranch(plan, branch.name, variant), plan)
    )));
    if (results.length === 1) return results[0];
    const completed = results.filter((result) => result.status === 'completed');
    if (completed.length === 0) return { ...results[0], query_variant: null };

    const candidates = new Map<string, BranchResult['candidates'][number]>();
    for (const result of completed) {
      for (const candidate of result.candidates) {
        const key = candidateKey(candidate.video_id, candidate.original_frame_id, candidate.start_ms, candidate.end_ms);
        const current = candidates.get(key);
        candidates.set(key, current
          ? {
              ...current,
              rank: Math.min(current.rank, candidate.rank),
              raw_score: Math.max(current.raw_score, candidate.raw_score),
              keyframe_no: current.keyframe_no ?? candidate.keyframe_no,
              evidence_ids: [...new Set([...current.evidence_ids, ...candidate.evidence_ids])],
              matched_terms: [...new Set([...(current.matched_terms ?? []), ...(candidate.matched_terms ?? [])])],
            }
          : candidate);
      }
    }
    const ranked = [...candidates.values()]
      .sort((left, right) => left.rank - right.rank || right.raw_score - left.raw_score)
      .slice(0, plan.top_k_per_branch)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    return {
      ...completed[0], query_variant: null, candidates: ranked,
      elapsed_ms: Math.max(...results.map((result) => result.elapsed_ms)),
      producer: `${completed[0].producer}-multi-variant`,
    };
  }
}
