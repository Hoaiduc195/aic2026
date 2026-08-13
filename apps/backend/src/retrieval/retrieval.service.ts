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
import type { TaskExecutorInput } from '../tasks/task-executor';
import { TaskExecutorRegistry } from '../tasks/task-registry';
import type { RetrievalStore } from './retrieval.store';
import type { EvidenceRepository, EvidenceView } from './evidence.repository';
import type { ObjectStorage } from '../storage/object-storage';

const DEFAULT_BRANCH_K = 200;
const DEFAULT_FUSION_K = 500;
const DEFAULT_DISPLAY_K = 100;

function detectLanguage(query: string): RetrievalExecutionPlan['language'] {
  const hasVietnamese = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(query);
  const hasLatin = /[a-z]/i.test(query);
  if (hasVietnamese) return 'vi';
  if (hasLatin) return 'en';
  return 'unknown';
}

function queryVariants(request: SearchRequest): string[] {
  if (request.task === 'trake') {
    const events = request.query.split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 20);
    return events.length > 1 ? events : [request.query];
  }
  if (request.task === 'vqa') {
    const parts = request.query.split(/\r?\n(?:câu hỏi|question)\s*:\s*/i).map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts : [request.query];
  }
  return [request.query];
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
  ) {}

  createPlan(request: SearchRequest): RetrievalExecutionPlan {
    const displayK = request.retrieval?.display_k ?? request.top_k ?? DEFAULT_DISPLAY_K;
    const fusionK = Math.max(request.retrieval?.fusion_k ?? DEFAULT_FUSION_K, displayK);
    const branchK = Math.max(request.retrieval?.branch_k ?? DEFAULT_BRANCH_K, fusionK > DEFAULT_FUSION_K ? displayK : 1);
    const targetGranularities = request.task === 'trake'
      ? ['frame', 'micro_event', 'context_window'] as const
      : request.task === 'vqa'
        ? ['frame', 'context_window'] as const
        : ['frame', 'segment'] as const;

    return {
      query_id: randomUUID(),
      task: request.task,
      language: detectLanguage(request.query),
      original_query: request.query,
      query_variants: queryVariants(request),
      concepts: [],
      text_constraints: [],
      audio_concepts: [],
      temporal_relations: request.task === 'trake' ? ['sequence'] : [],
      target_granularities: [...targetGranularities],
      branches: this.branches.map((branch) => branch.name),
      top_k_per_branch: Math.min(branchK, 10000),
      fusion_k: Math.min(fusionK, 10000),
      display_k: Math.min(displayK, 1000),
      latency_budget_ms: 5000,
      fallback_policy: request.task === 'vqa' ? 'expand_then_abstain' : 'expand_then_clarify',
      planner_version: 'static-all-branches-v1',
      fusion: 'rrf',
      index_version: this.config.indexVersion,
    };
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const plan = this.createPlan(request);
    const startedAt = performance.now();
    const branchResults = await Promise.all(
      this.branches.map((branch) => this.runBranchVariants(branch, plan)),
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
    try {
      const result = await branch.search(query, plan);
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
    }
  }

  private async runBranchVariants(branch: RetrievalBranch, plan: RetrievalExecutionPlan): Promise<BranchResult> {
    const results = await Promise.all(plan.query_variants.map((variant) => this.runBranch(branch, variant, plan)));
    if (results.length === 1) return results[0];
    const completed = results.filter((result) => result.status === 'completed');
    if (completed.length === 0) return { ...results[0], query_variant: null };

    const candidates = new Map<string, BranchResult['candidates'][number]>();
    for (const result of completed) {
      for (const candidate of result.candidates) {
        const key = `${candidate.video_id}:${candidate.original_frame_id ?? candidate.segment_id}`;
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
