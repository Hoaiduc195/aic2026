import type {
  BranchName, ChannelWeights, ObjectQueryConstraints, QueryAtom, QueryViews, RetrievalExecutionPlan, SearchRequest,
} from '../common/types';
import { extractObjectQuery, normalizeObjectText, objectAliases } from './object-ontology';

export const PLANNER_VERSION = 'deterministic-object-routing-v2';

const VIETNAMESE_PATTERN = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
const OCR_SIGNAL = /(chữ|biển hiệu|bảng hiệu|logo|văn bản|hiển thị|\bwritten\b|\btext\b|\bsign\b|\bsubtitle\b|caption on screen)/i;
const ASR_SIGNAL = /(nói|phát biểu|lời thoại|nghe thấy|âm thanh|\bsaid\b|\bsays\b|\bspeaks\b|\bspeech\b|\baudio\b|\bannounces?\b)/i;

export interface RegisteredBranch {
  readonly name: BranchName;
  readonly available?: boolean;
}

export function normalizeRetrievalText(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function detectQueryLanguage(query: string): RetrievalExecutionPlan['language'] {
  const hasVietnamese = VIETNAMESE_PATTERN.test(query);
  const hasLatin = /[a-z]/i.test(query);
  if (hasVietnamese && hasLatin) return 'vi';
  if (hasVietnamese) return 'vi';
  if (hasLatin) return 'en';
  return 'unknown';
}

export function buildQueryVariants(request: SearchRequest): string[] {
  if (request.task === 'trake') {
    const events = request.query.split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 20);
    return events.length > 1 ? events : [normalizeRetrievalText(request.query)];
  }
  if (request.task === 'vqa') {
    const parts = request.query.split(/\r?\n(?:câu hỏi|question)\s*:\s*/i).map(normalizeRetrievalText).filter(Boolean);
    return parts.length > 1 ? parts : [normalizeRetrievalText(request.query)];
  }
  return [normalizeRetrievalText(request.query)];
}

function quotedPhrases(query: string): string[] {
  return [...query.matchAll(/["“”']([^"“”']{1,200})["“”']/g)].map((match) => normalizeRetrievalText(match[1]));
}

function signaledQuotedPhrases(query: string, signal: RegExp): string[] {
  const results: string[] = [];
  for (const match of query.matchAll(/["“”']([^"“”']{1,200})["“”']/g)) {
    const prefix = query.slice(Math.max(0, (match.index ?? 0) - 60), match.index);
    if (signal.test(prefix)) results.push(normalizeRetrievalText(match[1]));
    signal.lastIndex = 0;
  }
  return results;
}

function extractConcepts(query: string, objectTerms: readonly string[]): string[] {
  const stopWords = new Set(['một', 'những', 'các', 'đang', 'và', 'là', 'có', 'the', 'a', 'an', 'is', 'are', 'and', 'of', 'to']);
  const tokens = normalizeRetrievalText(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set([...objectTerms, ...tokens.filter((token) => token.length > 2 && !stopWords.has(token)).slice(0, 16)])];
}

function extractNegatedObjects(query: string, objectTerms: readonly string[]): string[] {
  const normalized = normalizeObjectText(query);
  return objectTerms.filter((canonical) => objectAliases(canonical).some((alias) => {
    const normalizedAlias = normalizeObjectText(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)(?:khong co|khong|without|no)\\s+(?:mot\\s+|any\\s+)?${normalizedAlias}(?:\\s|$)`).test(normalized);
  }));
}

function buildAtoms(
  concepts: readonly string[], textConstraints: readonly string[], audioConcepts: readonly string[],
  objectTerms: readonly string[], temporal: RetrievalExecutionPlan['temporal_relations'], negative: readonly string[],
): QueryAtom[] {
  const values: Array<Omit<QueryAtom, 'id'>> = [
    ...concepts.filter((value) => !objectTerms.includes(value)).slice(0, 12)
      .map((value) => ({ type: 'visual_concept' as const, value, weight: 0.7 })),
    ...textConstraints.map((value) => ({ type: 'visible_text' as const, value, weight: 1.2 })),
    ...audioConcepts.map((value) => ({ type: 'spoken_text' as const, value, weight: 1.2 })),
    ...objectTerms.map((value) => ({ type: 'object' as const, value, weight: 1.0 })),
    ...temporal.map((value) => ({ type: 'temporal' as const, value, weight: 1.0 })),
    ...negative.map((value) => ({ type: 'negative' as const, value, weight: 1.0 })),
  ];
  return values.map((atom, index) => ({ id: `a${index + 1}`, ...atom }));
}

function temporalRelations(query: string): RetrievalExecutionPlan['temporal_relations'] {
  const relations = new Set<RetrievalExecutionPlan['temporal_relations'][number]>();
  if (/(trước khi|trước đó|\bbefore\b)/i.test(query)) relations.add('before');
  if (/(sau khi|sau đó|\bafter\b)/i.test(query)) relations.add('after');
  if (/(trong khi|đồng thời|\bwhile\b|\bduring\b)/i.test(query)) relations.add('during');
  if (/(gần đó|gần lúc|\bnear\b)/i.test(query)) relations.add('near');
  if (/(lần lượt|tiếp theo|sau đó|rồi|\bthen\b|\bsequence\b)/i.test(query)) relations.add('sequence');
  return [...relations];
}

function activeOrRegistered(branches: readonly RegisteredBranch[], name: BranchName): boolean {
  return branches.some((branch) => branch.name === name);
}

function available(branches: readonly RegisteredBranch[], name: BranchName): boolean {
  return branches.some((branch) => branch.name === name && branch.available !== false);
}

function selectBranches(
  registered: readonly RegisteredBranch[],
  hasOcr: boolean,
  hasAsr: boolean,
  hasObjects: boolean,
  hasTemporal: boolean,
): BranchName[] {
  const selected = new Set<BranchName>();
  const visualFallback = activeOrRegistered(registered, 'clip') ? 'clip' : 'visual';
  if (activeOrRegistered(registered, visualFallback)) selected.add(visualFallback);
  if (activeOrRegistered(registered, 'caption')) selected.add('caption');
  if (hasOcr) {
    if (activeOrRegistered(registered, 'ocr_lexical')) selected.add('ocr_lexical');
    if (available(registered, 'ocr_semantic')) selected.add('ocr_semantic');
  }
  if (hasAsr) {
    if (activeOrRegistered(registered, 'asr_lexical')) selected.add('asr_lexical');
    if (available(registered, 'asr_semantic')) selected.add('asr_semantic');
  }
  if (hasObjects && activeOrRegistered(registered, 'object')) selected.add('object');
  if (hasTemporal && available(registered, 'temporal')) selected.add('temporal');
  if (selected.size === 0 && registered[0]) selected.add(registered[0].name);
  return [...selected];
}

export function queryForBranch(plan: RetrievalExecutionPlan, branch: BranchName, variant?: string): string {
  if (branch === 'object') {
    const variantTerms = variant ? extractObjectQuery(variant).terms : [];
    const scoped = variantTerms.filter((term) => plan.object_terms.includes(term));
    return (scoped.length > 0 ? scoped : plan.object_terms).join(' ');
  }
  if (branch.startsWith('ocr_')) return plan.text_constraints.join(' ') || variant || plan.original_query;
  if (branch.startsWith('asr_') || branch === 'audio') return plan.audio_concepts.join(' ') || variant || plan.original_query;
  return variant || plan.query_views[branch] || plan.original_query;
}

export interface PlannerLimits {
  readonly branchK: number;
  readonly fusionK: number;
  readonly displayK: number;
  readonly latencyBudgetMs: number;
  readonly rrfK: number;
  readonly channelWeights?: ChannelWeights;
}

export function buildDeterministicPlan(
  request: SearchRequest,
  queryId: string,
  indexVersion: string,
  registeredBranches: readonly RegisteredBranch[],
  limits: PlannerLimits,
): RetrievalExecutionPlan {
  const normalized = normalizeRetrievalText(request.query);
  const quoted = quotedPhrases(normalized);
  const hasOcr = OCR_SIGNAL.test(normalized) || quoted.length > 0;
  const hasAsr = ASR_SIGNAL.test(normalized);
  const object = extractObjectQuery(normalized);
  const negativeObjects = extractNegatedObjects(normalized, object.terms);
  const positiveObjectTerms = object.terms.filter((term) => !negativeObjects.includes(term));
  const temporal = request.task === 'trake' ? ['sequence'] as RetrievalExecutionPlan['temporal_relations'] : temporalRelations(normalized);
  const ocrQuoted = signaledQuotedPhrases(normalized, /(chữ|ghi|biển|bảng|logo|written|text|sign)/i);
  const asrQuoted = signaledQuotedPhrases(normalized, /(nói|phát biểu|said|says|speech|announce)/i);
  const textConstraints = hasOcr ? ocrQuoted.length > 0 ? ocrQuoted : quoted.length > 0 ? quoted : [normalized] : [];
  const audioConcepts = hasAsr ? asrQuoted.length > 0 ? asrQuoted : quoted.length > 0 ? quoted : [normalized] : [];
  const objectConstraints: ObjectQueryConstraints = {
    class_filters: positiveObjectTerms,
    excluded_classes: negativeObjects,
    min_confidence: 0.25,
    counts: object.counts,
    spatial: object.spatial,
  };
  const branches = selectBranches(registeredBranches, hasOcr, hasAsr, positiveObjectTerms.length > 0, temporal.length > 0);
  const queryViews: QueryViews = {};
  const channelWeights: ChannelWeights = {};
  for (const branch of branches) {
    queryViews[branch] = branch === 'object' ? positiveObjectTerms.join(' ') || normalized
      : branch.startsWith('ocr_') ? textConstraints.join(' ') || normalized
        : branch.startsWith('asr_') || branch === 'audio' ? audioConcepts.join(' ') || normalized
          : normalized;
    const defaultWeight = branch === 'object' ? 1.2
      : branch.startsWith('ocr_') && hasOcr ? 1.25
        : branch.startsWith('asr_') && hasAsr ? 1.25
          : branch === 'caption' ? 1.0 : 1.0;
    channelWeights[branch] = limits.channelWeights?.[branch] ?? defaultWeight;
  }

  const targetGranularities = ['frame'] as const;

  return {
    query_id: queryId,
    task: request.task,
    language: detectQueryLanguage(normalized),
    original_query: normalized,
    query_variants: buildQueryVariants(request),
    concepts: extractConcepts(normalized, positiveObjectTerms),
    query_atoms: buildAtoms(
      extractConcepts(normalized, positiveObjectTerms), textConstraints, audioConcepts,
      positiveObjectTerms, temporal, negativeObjects,
    ),
    negative_concepts: negativeObjects,
    text_constraints: textConstraints,
    audio_concepts: audioConcepts,
    object_terms: positiveObjectTerms,
    object_constraints: objectConstraints,
    query_views: queryViews,
    channel_weights: channelWeights,
    temporal_relations: temporal,
    target_granularities: [...targetGranularities],
    branches,
    top_k_per_branch: Math.min(limits.branchK, 10000),
    fusion_k: Math.min(limits.fusionK, 10000),
    display_k: Math.min(limits.displayK, 1000),
    rrf_k: Math.min(limits.rrfK, 1000),
    latency_budget_ms: limits.latencyBudgetMs,
    fallback_policy: request.task === 'vqa' ? 'expand_then_abstain' : 'expand_then_clarify',
    planner_version: PLANNER_VERSION,
    fusion: 'rrf',
    index_version: indexVersion,
    hard_filters: {},
    transformations: ['unicode_nfkc', 'collapse_whitespace', 'channel_specific_query_views', 'coco_object_aliases'],
  };
}
