import { Module } from '@nestjs/common';
import { ExecutorRegistry } from '../executors/executor-registry';
import { QueryPlanner } from '../planner/query-planner';
import { BranchRuntime } from '../retrieval/branch-runtime';
import { LexicalEvidenceBranch } from '../retrieval/lexical-evidence-branch';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
const goldenEvidence = [
  { segmentId: 'seg-red-motorbike', videoId: 'golden-video', startMs: 1000, endMs: 2500, text: 'xe máy màu đỏ red motorbike on street', evidenceIds: ['ev-visual-red-motorbike'] },
  { segmentId: 'seg-ben-thanh', videoId: 'golden-video', startMs: 3000, endMs: 4500, text: 'Bến Thành xe buýt số 18 bus', evidenceIds: ['ev-ocr-ben-thanh'] },
  { segmentId: 'seg-nguyen-hue', videoId: 'golden-video', startMs: 5000, endMs: 6800, text: 'đi đến Nguyễn Huệ go to Nguyen Hue', evidenceIds: ['ev-asr-nguyen-hue'] },
] as const;

@Module({ controllers: [SearchController], providers: [
  SearchService, QueryPlanner, ExecutorRegistry,
  { provide: BranchRuntime, useFactory: () => {
    if (process.env.AIC_FIXTURE_INDEX_ENABLED === 'false') return new BranchRuntime([]);
    return new BranchRuntime([
      new LexicalEvidenceBranch('visual', goldenEvidence.slice(0, 1)),
      new LexicalEvidenceBranch('ocr_lexical', goldenEvidence.slice(1, 2)),
      new LexicalEvidenceBranch('asr_lexical', goldenEvidence.slice(2, 3)),
    ]);
  } },
] })
export class SearchModule {}
