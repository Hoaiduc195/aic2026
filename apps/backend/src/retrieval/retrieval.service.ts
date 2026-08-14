import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  APP_CONFIG, EVIDENCE_REPOSITORY, OBJECT_STORAGE, RETRIEVAL_BRANCHES,
  RETRIEVAL_STORE, TASK_EXECUTOR_REGISTRY,
} from '../common/tokens';
import type {
  BranchName,
  BranchResult,
  RetrievalExecutionPlan,
  SearchRequest,
  SearchResponse,
} from '../common/types';
import type { BackendConfig } from '../common/config';
import { fuseBranchResults } from './fusion';
import type { RetrievalBranch } from './branch';
import { buildDeterministicPlan, queryForBranch } from './query-planner';
import type { TaskExecutorInput } from '../tasks/task-executor';
import { TaskExecutorRegistry } from '../tasks/task-registry';
import type { RetrievalStore } from './retrieval.store';
import type { EvidenceRepository, EvidenceView } from './evidence.repository';
import type { ObjectStorage } from '../storage/object-storage';

const DEFAULT_BRANCH_K = 200;
const DEFAULT_FUSION_K = 500;
const DEFAULT_DISPLAY_K = 100;

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
  ) {}

  createPlan(request: SearchRequest): RetrievalExecutionPlan {
    const displayK = request.retrieval?.display_k ?? request.top_k ?? DEFAULT_DISPLAY_K;
    const fusionK = Math.max(request.retrieval?.fusion_k ?? DEFAULT_FUSION_K, displayK);
    const branchK = Math.max(request.retrieval?.branch_k ?? DEFAULT_BRANCH_K, fusionK > DEFAULT_FUSION_K ? displayK : 1);
    const plan = buildDeterministicPlan(
      request,
      randomUUID(),
      this.config.indexVersion,
      this.branches,
      { branchK, fusionK, displayK, latencyBudgetMs: request.retrieval?.latency_budget_ms ?? 5000 },
    );
    this.logger.debug(JSON.stringify({ event: 'query_plan_created', plan }));
    return plan;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const plan = this.createPlan(request);
    const startedAt = performance.now();
    const branchResults = await Promise.all(
      this.branches
        .filter((branch) => plan.branches.includes(branch.name))
        .map((branch) => this.runBranchVariants(branch, plan)),
    );
    const fusedCandidates = fuseBranchResults(branchResults, plan);
    const warnings: string[] = [];
    let candidates = fusedCandidates;
    if (this.storage?.isConfigured) {
      try {
        candidates = await Promise.all(fusedCandidates.map(async (candidate) => {
          const prefix = 'r2://media/';
          return candidate.preview_uri?.startsWith(prefix)
            ? { ...candidate, preview_uri: await this.storage!.signReadUrl(candidate.preview_uri.slice(prefix.length)) }
            : candidate;
        }));
      } catch (error) {
        this.logger.warn(`preview signing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        warnings.push('preview_signing_failed');
      }
    }

    let evidenceById: ReadonlyMap<string, EvidenceView> = new Map();
    try {
      const evidenceIds = [...new Set(candidates.flatMap((candidate) => candidate.evidence_ids))];
      evidenceById = await this.evidenceRepository?.findByIds(evidenceIds) ?? evidenceById;
    } catch (error) {
      this.logger.warn(`evidence hydration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      warnings.push('evidence_hydration_failed');
    }
    try {
      await this.store?.saveRun(request, plan, candidates);
    } catch (error) {
      this.logger.warn(`retrieval persistence failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      warnings.push('retrieval_persistence_failed');
    }
    const executor = this.executors.resolve(request.task);
    const input: TaskExecutorInput = {
      request,
      plan,
      branchResults,
      candidates,
      elapsedMs: Math.round(performance.now() - startedAt),
      config: this.config,
      evidenceById,
    };
    const response = await executor.execute(input);
    return warnings.length > 0
      ? { ...response, warnings: [...response.warnings, ...warnings] }
      : response;
  }

  private async runBranch(
    branch: RetrievalBranch,
    query: string,
    plan: RetrievalExecutionPlan,
  ): Promise<BranchResult> {
    const startedAt = performance.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<BranchResult>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({
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
        }), plan.latency_budget_ms);
      });
      const result = await Promise.race([branch.search(query, plan), timeout]);
      return { ...result, elapsed_ms: Math.max(result.elapsed_ms, Math.round(performance.now() - startedAt)) };
    } catch (error) {
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
        const key = `${candidate.video_id}:${candidate.segment_id}`;
        const current = candidates.get(key);
        candidates.set(key, current
          ? {
              ...current,
              rank: Math.min(current.rank, candidate.rank),
              raw_score: Math.max(current.raw_score, candidate.raw_score),
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
