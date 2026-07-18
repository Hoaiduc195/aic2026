import { Injectable } from '@nestjs/common';
import { immutable, immutableArray } from '../common/immutable';
import { BranchName, TaskType } from '../retrieval/retrieval.types';

export interface PlannerInput {
  readonly query: string; readonly task: 'auto' | TaskType;
  readonly topK: number; readonly latencyBudgetMs: number;
}
export interface QueryPlan {
  readonly task: TaskType; readonly language: 'vi' | 'en' | 'mixed';
  readonly queryVariants: readonly string[]; readonly branches: readonly BranchName[];
  readonly topK: number; readonly latencyBudgetMs: number;
}

const VIETNAMESE = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
const OCR_CUE = /["“”]|\b(sign|address|plate|text|biển|địa chỉ|biển hiệu)\b/i;
const ASR_CUE = /\b(say|said|speak|spoke|hear|nói|nghe|phát biểu)\b/i;

function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

@Injectable()
export class QueryPlanner {
  compile(input: PlannerInput): QueryPlan {
    const normalized = input.query.trim().replace(/\s+/g, ' ').toLowerCase();
    const hasVi = VIETNAMESE.test(normalized);
    const hasLatinWords = /\b(the|what|find|person|red|motorbike|video)\b/i.test(normalized);
    const language = hasVi && hasLatinWords ? 'mixed' : hasVi ? 'vi' : 'en';
    const variants = language === 'en' ? [normalized] : [normalized, removeDiacritics(normalized)];
    const branches: BranchName[] = ['visual'];
    if (OCR_CUE.test(normalized) || /\d/.test(normalized)) branches.push('ocr_lexical');
    if (ASR_CUE.test(normalized)) branches.push('asr_lexical');
    if (branches.length === 1) branches.push('ocr_lexical', 'asr_lexical');
    const task: TaskType = input.task === 'auto' ? 'textual_kis' : input.task;
    return immutable({
      task, language,
      queryVariants: immutableArray([...new Set(variants)]),
      branches: immutableArray([...new Set(branches)]),
      topK: input.topK, latencyBudgetMs: input.latencyBudgetMs,
    });
  }
}
