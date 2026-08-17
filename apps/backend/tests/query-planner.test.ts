import { describe, expect, it } from 'vitest';

import { buildDeterministicPlan, queryForBranch } from '../src/retrieval/query-planner';
import { extractObjectQuery } from '../src/retrieval/object-ontology';

const registered = [
  { name: 'clip' as const }, { name: 'caption' as const }, { name: 'ocr_lexical' as const },
  { name: 'ocr_semantic' as const, available: false }, { name: 'asr_lexical' as const },
  { name: 'asr_semantic' as const, available: false }, { name: 'object' as const },
  { name: 'temporal' as const, available: false },
];
const limits = { branchK: 200, fusionK: 100, displayK: 20, latencyBudgetMs: 1500, rrfK: 60 };

function plan(query: string) {
  return buildDeterministicPlan({ query, task: 'textual_kis' }, 'query-fixed', 'index-v1', registered, limits);
}

describe('deterministic query planner', () => {
  it('extracts bilingual COCO object terms, counts and spatial constraints', () => {
    const extraction = extractObjectQuery('hai người đứng bên trái một chiếc xe đạp và cầm chai nước');
    expect(extraction.terms).toEqual(expect.arrayContaining(['person', 'bicycle', 'bottle']));
    expect(extraction.counts.person).toBe(2);
    expect(extraction.spatial).toContain('left');
  });

  it('normalizes English plural object labels to canonical singular terms', () => {
    const extraction = extractObjectQuery('two bicycles beside three bottles');
    expect(extraction.terms).toEqual(expect.arrayContaining(['bicycle', 'bottle']));
    expect(extraction.counts).toMatchObject({ bicycle: 2, bottle: 3 });
  });

  it('always routes generic action queries through visual and caption fallback', () => {
    const result = plan('một vận động viên chạy qua vạch đích');
    expect(result.branches).toEqual(['clip', 'caption']);
    expect(result.query_views.clip).toContain('vạch đích');
    expect(result.query_views.caption).toBe(result.original_query);
  });

  it('routes visible text, speech and objects to their channel-specific views', () => {
    const result = plan('người đàn ông cầm chai trước bảng hiệu có chữ "HỘI THI AI" và nói "xin chào"');
    expect(result.branches).toEqual(expect.arrayContaining(['clip', 'caption', 'ocr_lexical', 'asr_lexical', 'object']));
    expect(result.object_terms).toEqual(expect.arrayContaining(['person', 'bottle']));
    expect(queryForBranch(result, 'object')).toBe('person bottle');
    expect(queryForBranch(result, 'ocr_lexical')).toContain('HỘI THI AI');
    expect(queryForBranch(result, 'asr_lexical')).toContain('xin chào');
    expect(result.branches).not.toContain('ocr_semantic');
    expect(result.branches).not.toContain('asr_semantic');
  });

  it('extracts temporal relations into explicit atoms', () => {
    const result = plan('người mở cửa trước khi đặt chai xuống bàn, sau đó rời đi');
    expect(result.temporal_relations).toEqual(expect.arrayContaining(['before', 'after', 'sequence']));
    expect(result.query_atoms.some((atom) => atom.type === 'temporal' && atom.value === 'before')).toBe(true);
  });

  it('does not turn a negated object into a positive object filter', () => {
    const result = plan('một căn phòng không có người');
    expect(result.object_terms).not.toContain('person');
    expect(result.object_constraints.excluded_classes).toContain('person');
    expect(result.query_atoms.some((atom) => atom.type === 'negative' && atom.value === 'person')).toBe(true);
  });

  it('is deterministic apart from the caller-supplied query id', () => {
    expect(plan('hai chiếc xe máy').object_terms).toEqual(plan('hai chiếc xe máy').object_terms);
    expect(plan('hai chiếc xe máy').channel_weights).toEqual(plan('hai chiếc xe máy').channel_weights);
  });
});
