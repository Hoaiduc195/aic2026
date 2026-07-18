import { QueryPlanner } from '../src/planner/query-planner';

describe('QueryPlanner', () => {
  const planner = new QueryPlanner();

  it('creates an immutable bilingual OCR-aware plan', () => {
    const plan = planner.compile({
      query: 'Xe máy đỏ qua biển hiệu "123 Nguyễn Huệ"',
      task: 'auto', topK: 20, latencyBudgetMs: 900,
    });
    expect(plan.language).toBe('vi');
    expect(plan.queryVariants).toContain('xe may do qua bien hieu "123 nguyen hue"');
    expect(plan.branches).toEqual(expect.arrayContaining(['visual', 'ocr_lexical']));
    expect(plan.task).toBe('textual_kis');
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('routes speech queries to ASR', () => {
    const plan = planner.compile({ query: 'what did the person say?', task: 'vqa', topK: 10, latencyBudgetMs: 500 });
    expect(plan.branches).toContain('asr_lexical');
    expect(plan.task).toBe('vqa');
  });
});
