import { Injectable, Optional } from '@nestjs/common';
import { immutable, immutableArray } from '../common/immutable';
import { BranchName, BranchQuery, BranchResult, RetrievalBranch } from './retrieval.types';

@Injectable()
export class BranchRuntime {
  private readonly branches: ReadonlyMap<BranchName, RetrievalBranch>;
  constructor(@Optional() branches: readonly RetrievalBranch[] = []) {
    this.branches = new Map(branches.map((branch) => [branch.name, branch]));
  }

  execute(names: readonly BranchName[], query: BranchQuery, deadlineMs: number): Promise<readonly BranchResult[]> {
    return Promise.all(names.map((name) => this.executeOne(name, query, deadlineMs))).then(immutableArray);
  }

  private async executeOne(name: BranchName, query: BranchQuery, deadlineMs: number): Promise<BranchResult> {
    const branch = this.branches.get(name);
    if (!branch) return immutable({ branch: name, status: 'unavailable', elapsedMs: 0, candidates: immutableArray([]) });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const candidates = await Promise.race([
        branch.search(query),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BranchTimeout()), deadlineMs); }),
      ]);
      const validated = candidates.map((candidate) => validateCandidate(candidate));
      return immutable({ branch: name, status: 'completed', elapsedMs: Date.now() - started, candidates: immutableArray(validated) });
    } catch (error) {
      const timedOut = error instanceof BranchTimeout;
      return immutable({ branch: name, status: timedOut ? 'timed_out' : 'failed', elapsedMs: Date.now() - started, candidates: immutableArray([]), errorCode: timedOut ? 'BRANCH_TIMEOUT' : 'BRANCH_FAILED' });
    } finally { if (timer) clearTimeout(timer); }
  }
}
class BranchTimeout extends Error {}

function validateCandidate(candidate: import('./retrieval.types').BranchCandidate) {
  if (!candidate.segmentId || !candidate.videoId || !Number.isInteger(candidate.rank) || candidate.rank < 1
    || !Number.isInteger(candidate.startMs) || !Number.isInteger(candidate.endMs)
    || candidate.startMs < 0 || candidate.endMs <= candidate.startMs || !Number.isFinite(candidate.rawScore)
    || candidate.evidenceIds.length === 0 || candidate.evidenceIds.some((id) => !id)) {
    throw new Error('Branch returned an invalid candidate');
  }
  return immutable({ ...candidate, evidenceIds: immutableArray(candidate.evidenceIds) });
}
