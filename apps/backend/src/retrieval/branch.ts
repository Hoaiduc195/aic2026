import type { BranchName, BranchResult, RetrievalExecutionPlan } from '../common/types';

export interface RetrievalBranch {
  readonly name: BranchName;
  readonly available?: boolean;
  search(query: string, plan: RetrievalExecutionPlan): Promise<BranchResult>;
}

export class UnavailableRetrievalBranch implements RetrievalBranch {
  readonly available = false;
  constructor(
    public readonly name: BranchName,
    private readonly reason = 'retrieval index adapter is not configured',
  ) {}

  async search(_query: string, plan: RetrievalExecutionPlan): Promise<BranchResult> {
    return {
      query_id: plan.query_id,
      branch: this.name,
      status: 'unavailable',
      query_variant: plan.original_query,
      candidates: [],
      elapsed_ms: 0,
      deadline_ms: plan.latency_budget_ms,
      index_version: plan.index_version,
      producer: 'unconfigured-branch',
      error: { code: 'INDEX_NOT_CONFIGURED', message: this.reason, recoverable: true },
    };
  }
}
