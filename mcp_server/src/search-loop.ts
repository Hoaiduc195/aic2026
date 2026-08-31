import { rankFrameCandidates } from './ranking.js';
import { SearchSessionStore } from './session-store.js';
import type {
  BackendCandidatePage,
  BackendClientPort,
  BackendFrame,
  BackendRetrievalPlan,
  BackendSearchResponse,
  BackendSearchResult,
  BackendVqaAnswer,
  FrameEvidenceSummary,
  FrameRef,
  RankedFrame,
  SearchLoopInput,
  SearchLoopReport,
  SearchLoopStatus,
  ToolCallTrace,
  TrakeCoverageReport,
} from './types.js';

export interface SearchLoopOptions {
  readonly maxResults: number;
  readonly maxNearbyFrames: number;
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly timeBudgetMs: number;
  readonly now?: () => number;
}

const HARD_MAX_ITERATIONS = 8;
const HARD_MAX_TOOL_CALLS = 50;
const HARD_MAX_TIME_BUDGET_MS = 120_000;
const DEFAULT_TARGET_CONFIDENCE = 0.75;
export const MAX_TRAKE_EVENTS = 20;

export class SearchLoopService {
  private readonly now: () => number;

  constructor(
    private readonly backend: BackendClientPort,
    private readonly sessions: SearchSessionStore,
    private readonly options: SearchLoopOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async run(input: SearchLoopInput): Promise<SearchLoopReport> {
    const startedAt = this.now();
    const maxIterations = clampInteger(input.maxIterations ?? this.options.maxIterations, 1, HARD_MAX_ITERATIONS);
    const maxToolCalls = clampInteger(input.maxToolCalls ?? this.options.maxToolCalls, 1, HARD_MAX_TOOL_CALLS);
    const timeBudgetMs = clampInteger(input.timeBudgetMs ?? this.options.timeBudgetMs, 1_000, HARD_MAX_TIME_BUDGET_MS);
    const targetConfidence = clampNumber(input.targetConfidence ?? DEFAULT_TARGET_CONFIDENCE, 0, 1);
    const warnings: string[] = [];
    const calls: ToolCallTrace[] = [];
    const attemptedFrames: FrameRef[] = [];
    const selectedFrames: FrameRef[] = [];
    const rejectedFrames: FrameRef[] = [];
    const evidence: FrameEvidenceSummary[] = [];
    const nearbyFrames: FrameRef[] = [];
    const images: ImageSummary[] = [];
    const evidenceByKey = new Map<string, FrameEvidenceSummary>();
    const attemptedKeys = new Set<string>();
    const imageKeys = new Set<string>();
    const answeredFrameKeys = new Set<string>();
    let budgetExceeded = false;
    let iterations = 0;
    let searchResponse: BackendSearchResponse | undefined;
    let plan: BackendRetrievalPlan | undefined;
    let candidates: BackendCandidatePage | undefined;
    let vqa: BackendVqaAnswer | undefined;
    // Query rewriting is performed by the calling agent according to the MCP
    // server instructions. The loop only removes surrounding whitespace.
    let improvedQuery = input.query.trim();
    let improvedQuestion = input.question?.trim();
    const requiredEvents = normalizeTrakeEvents(input);
    const session = this.sessions.get(input.sessionId ?? '')
      ?? this.sessions.create({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        task: input.task,
        originalQuery: input.query.trim(),
        ...(input.question ? { originalQuestion: input.question.trim() } : {}),
        requiredEvents,
      });
    const sessionId = session.sessionId;

    if (input.task === 'vqa' && !input.question?.trim()) {
      return this.finish({
        sessionId,
        input,
        improvedQuery,
        improvedQuestion,
        plan,
        results: [],
        rankedFrames: [],
        evidence,
        nearbyFrames,
        candidates,
        vqa,
        trake: undefined,
        confidence: 0,
        status: 'insufficient',
        stopReason: 'vqa_question_required',
        iterations,
        calls,
        warnings: [...warnings, 'question_required_for_vqa'],
        attemptedFrames,
        selectedFrames,
        rejectedFrames,
      });
    }

    this.updateSession(sessionId, { improvedQuery, ...(improvedQuestion ? { improvedQuestion } : {}), warnings });

    plan = await this.call(calls, 'plan_search', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.planSearch({
      query: improvedQuery,
      task: input.task,
      topK: Math.min(this.options.maxResults, 10),
      sessionId,
    }));
    if (!plan) warnings.push('search_plan_unavailable');

    const seedFrames = input.seedFrames?.slice(0, 100) ?? [];
    let pendingFrames: FrameRef[] = seedFrames.map((frame) => ({ ...frame }));
    let previousVqaStatus: BackendVqaAnswer['answer_status'] | undefined;
    let stopReason = 'search_budget_exhausted';
    let confidence = 0;
    let trake: TrakeCoverageReport | undefined;

    for (iterations = 1; iterations <= maxIterations; iterations += 1) {
      if (this.timeExceeded(startedAt, timeBudgetMs)) {
        budgetExceeded = true;
        stopReason = 'time_budget_exhausted';
        break;
      }
      const currentTopK = Math.min(this.options.maxResults, Math.max(4, 8 * iterations));
      const currentResponse = pendingFrames.length > 0 && iterations === 1
        ? await this.call(calls, 'search_exact_frames', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.searchExactFrames({ task: input.task, frames: pendingFrames, sessionId }))
        : await this.call(calls, 'search_frames', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.searchFrames({
          query: improvedQuery,
          task: input.task,
          topK: currentTopK,
          sessionId,
          retrieval: iterations === 1 ? undefined : { display_k: currentTopK, fusion_k: currentTopK, branch_k: Math.min(100, currentTopK * 2) },
        }));
      if (!currentResponse) {
        budgetExceeded = calls.length >= maxToolCalls || this.timeExceeded(startedAt, timeBudgetMs);
        stopReason = budgetExceeded ? (calls.length >= maxToolCalls ? 'tool_call_budget_exhausted' : 'time_budget_exhausted') : 'search_unavailable';
        break;
      }
      searchResponse = mergeSearchResponses(searchResponse, currentResponse);
      for (const result of currentResponse.results) {
        const ref = resultFrameRef(result);
        if (ref) pendingFrames = appendUniqueFrames(pendingFrames, [ref]);
      }

      if (!candidates && currentResponse.query_id) {
        candidates = await this.call(calls, 'get_candidates', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.getCandidates({
          queryId: currentResponse.query_id,
          limit: Math.min(this.options.maxResults, 100),
          offset: 0,
        }));
        if (candidates) {
          pendingFrames = appendUniqueFrames(pendingFrames, candidates.candidates.flatMap((candidate) => candidate.original_frame_id === null
            ? []
            : [{ videoId: candidate.video_id, originalFrameId: candidate.original_frame_id }]));
        }
      }

      const rankedFrames = rankSearchResults(searchResponse.results);
      const rankedRefs = rankedFrames.map((item) => ({ videoId: item.videoId, originalFrameId: item.originalFrameId, ...(item.keyframeNo === undefined ? {} : { keyframeNo: item.keyframeNo }) }));
      const refsToLoad = appendUniqueFrames(rankedRefs, pendingFrames).slice(0, Math.min(this.options.maxResults, 20));
      for (const ref of refsToLoad) {
        const key = frameKey(ref);
        if (attemptedKeys.has(key)) continue;
        attemptedKeys.add(key);
        attemptedFrames.push({ ...ref });
        const frame = await this.call(calls, 'get_frame', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.getFrame(ref));
        if (!frame) {
          rejectedFrames.push({ ...ref });
          continue;
        }
        const summary = summarizeFrame(frame);
        evidenceByKey.set(frameKey(summary), summary);
        evidence.splice(0, evidence.length, ...[...evidenceByKey.values()].sort((left, right) => left.timestampMs - right.timestampMs));
        if (input.includeImages && !imageKeys.has(key)) {
          imageKeys.add(key);
          const image = await this.call(calls, 'get_frame_image', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.getFrameImage(ref));
          if (image) images.push({ videoId: frame.video_id, originalFrameId: frame.original_frame_id, mimeType: image.mimeType, bytes: image.bytes.length });
        }
        if (this.callBudgetReached(calls, maxToolCalls)) {
          budgetExceeded = true;
          break;
        }
      }

      const backendConfidence = searchResponse.confidence?.score ?? 0;
      confidence = Math.max(confidence, clampNumber(backendConfidence, 0, 1));
      trake = input.task === 'trake' ? assessTrake(requiredEvents, evidence) : undefined;
      if (trake) {
        selectedFrames.splice(0, selectedFrames.length, ...trake.selectedFrames.map((item) => ({ ...item })));
        confidence = Math.min(clampNumber(backendConfidence, 0, 1), trake.coveredEvents.length / Math.max(requiredEvents.length, 1));
        if (trake.coveredEvents.length === requiredEvents.length && trake.chronological && confidence >= targetConfidence) {
          stopReason = 'target_confidence_and_trake_coverage_reached';
          return this.finish({ sessionId, input, improvedQuery, improvedQuestion, plan, results: searchResponse.results, rankedFrames, evidence, nearbyFrames, candidates, vqa, trake, confidence, status: 'supported', stopReason, iterations, calls, warnings, attemptedFrames, selectedFrames, rejectedFrames, images });
        }
      }

      const vqaFrame = input.task === 'vqa' ? selectVqaFrame(evidence, answeredFrameKeys) : undefined;
      if (vqaFrame && searchResponse.query_id) {
        const answer = await this.call(calls, 'suggest_vqa_answer', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.getVqaAnswer({
          queryId: searchResponse!.query_id,
          question: improvedQuestion ?? input.question!.trim(),
          frame: { videoId: vqaFrame.videoId, originalFrameId: vqaFrame.originalFrameId },
        }));
        if (answer) {
          vqa = answer;
          answeredFrameKeys.add(frameKey(vqaFrame));
          previousVqaStatus = answer.answer_status;
          confidence = answer.confidence.score;
          if (answer.answer_status === 'answered' && answer.confidence.score >= targetConfidence) {
            selectedFrames.splice(0, selectedFrames.length, { videoId: answer.video_id, originalFrameId: answer.original_frame_id });
            stopReason = 'target_confidence_and_grounded_vqa_reached';
            return this.finish({ sessionId, input, improvedQuery, improvedQuestion, plan, results: searchResponse.results, rankedFrames, evidence, nearbyFrames, candidates, vqa, trake, confidence, status: 'supported', stopReason, iterations, calls, warnings, attemptedFrames, selectedFrames, rejectedFrames, images });
          }
        }
      }

      if (this.callBudgetReached(calls, maxToolCalls)) {
        budgetExceeded = true;
        stopReason = 'tool_call_budget_exhausted';
        break;
      }

      if (input.task !== 'trake' && input.task !== 'vqa' && evidence.length > 0 && confidence >= targetConfidence && searchResponse.confidence?.action !== 'expand') {
        selectedFrames.splice(0, selectedFrames.length, { videoId: evidence[0].videoId, originalFrameId: evidence[0].originalFrameId });
        stopReason = 'target_confidence_and_exact_evidence_reached';
        return this.finish({ sessionId, input, improvedQuery, improvedQuestion, plan, results: searchResponse.results, rankedFrames, evidence, nearbyFrames, candidates, vqa, trake, confidence, status: 'supported', stopReason, iterations, calls, warnings, attemptedFrames, selectedFrames, rejectedFrames, images });
      }

      const nearbySeed = (vqaFrame ?? rankedRefs[0]);
      if (nearbySeed) {
        const nearby = await this.call(calls, 'get_nearby_frames', maxToolCalls, startedAt, timeBudgetMs, warnings, () => this.backend.getNearbyFrames(
          nearbySeed.videoId,
          nearbySeed.originalFrameId!,
          Math.min(this.options.maxNearbyFrames, 10),
        ));
        if (nearby) {
          const refs = nearby.frames.map((item) => ({ videoId: item.video_id, originalFrameId: item.original_frame_id, keyframeNo: item.keyframe_no }));
          pendingFrames = appendUniqueFrames(pendingFrames, refs);
          for (const ref of refs) {
            if (ref.originalFrameId === nearbySeed.originalFrameId) continue;
            if (nearbyFrames.every((item) => frameKey(item) !== frameKey(ref))) nearbyFrames.push({ ...ref });
          }
        }
      }

      this.updateSession(sessionId, {
        iterations,
        toolCalls: calls,
        attemptedFrames,
        selectedFrames,
        rejectedFrames,
        evidence,
        warnings,
      });
      if (previousVqaStatus === 'abstained') warnings.push('vqa_abstained_after_current_evidence');
    }

    const rankedFrames = searchResponse ? rankSearchResults(searchResponse.results) : [];
    const finalStatus: SearchLoopStatus = budgetExceeded
      ? 'budget_exhausted'
      : evidence.length > 0 || (searchResponse?.results.length ?? 0) > 0
        ? 'uncertain'
        : 'insufficient';
    const finalReason = stopReason || (finalStatus === 'insufficient' ? 'no_grounded_results' : 'confidence_target_not_reached');
    return this.finish({ sessionId, input, improvedQuery, improvedQuestion, plan, results: searchResponse?.results ?? [], rankedFrames, evidence, nearbyFrames, candidates, vqa, trake, confidence, status: finalStatus, stopReason: finalReason, iterations, calls, warnings, attemptedFrames, selectedFrames, rejectedFrames, images });
  }

  private async call<T>(
    calls: ToolCallTrace[],
    tool: string,
    maxToolCalls: number,
    startedAt: number,
    timeBudgetMs: number,
    warnings: string[],
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.callBudgetReached(calls, maxToolCalls) || this.timeExceeded(startedAt, timeBudgetMs)) return undefined;
    const started = this.now();
    try {
      const result = await operation();
      calls.push({ tool, status: 'ok', durationMs: Math.max(0, this.now() - started) });
      return result;
    } catch (error) {
      calls.push({ tool, status: 'error', durationMs: Math.max(0, this.now() - started), error: 'backend operation failed' });
      warnings.push(`${tool}_failed`);
      return undefined;
    }
  }

  private callBudgetReached(calls: readonly ToolCallTrace[], maxToolCalls: number): boolean {
    return calls.length >= maxToolCalls;
  }

  private timeExceeded(startedAt: number, timeBudgetMs: number): boolean {
    return this.now() - startedAt >= timeBudgetMs;
  }

  private updateSession(sessionId: string, patch: Parameters<SearchSessionStore['update']>[1]): void {
    try {
      this.sessions.update(sessionId, patch);
    } catch {
      // The report remains useful even if a caller supplied an expired session ID.
    }
  }

  private finish(input: FinishInput): SearchLoopReport {
    this.updateSession(input.sessionId, {
      iterations: input.iterations,
      toolCalls: input.calls,
      attemptedFrames: input.attemptedFrames,
      selectedFrames: input.selectedFrames,
      rejectedFrames: input.rejectedFrames,
      evidence: input.evidence,
      warnings: input.warnings,
      status: input.status,
      stopReason: input.stopReason,
    });
    return {
      sessionId: input.sessionId,
      status: input.status,
      stopReason: input.stopReason,
      iterations: input.iterations,
      toolCalls: [...input.calls],
      originalQuery: input.input.query,
      improvedQuery: input.improvedQuery,
      ...(input.improvedQuestion ? { improvedQuestion: input.improvedQuestion } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      results: input.results,
      rankedFrames: input.rankedFrames,
      evidence: input.evidence,
      nearbyFrames: input.nearbyFrames,
      images: input.images ?? [],
      ...(input.candidates ? { candidates: input.candidates } : {}),
      ...(input.vqa ? { vqa: input.vqa } : {}),
      ...(input.trake ? { trake: input.trake } : {}),
      confidence: clampNumber(input.confidence, 0, 1),
      warnings: [...new Set(input.warnings)],
    };
  }
}

interface ImageSummary {
  readonly videoId: string;
  readonly originalFrameId: number;
  readonly mimeType: string;
  readonly bytes: number;
}

interface FinishInput {
  readonly sessionId: string;
  readonly input: SearchLoopInput;
  readonly improvedQuery: string;
  readonly improvedQuestion?: string;
  readonly plan?: BackendRetrievalPlan;
  readonly results: readonly BackendSearchResult[];
  readonly rankedFrames: readonly RankedFrame[];
  readonly evidence: readonly FrameEvidenceSummary[];
  readonly nearbyFrames: readonly FrameRef[];
  readonly candidates?: BackendCandidatePage;
  readonly vqa?: BackendVqaAnswer;
  readonly trake?: TrakeCoverageReport;
  readonly confidence: number;
  readonly status: SearchLoopStatus;
  readonly stopReason: string;
  readonly iterations: number;
  readonly calls: readonly ToolCallTrace[];
  readonly warnings: readonly string[];
  readonly attemptedFrames: readonly FrameRef[];
  readonly selectedFrames: readonly FrameRef[];
  readonly rejectedFrames: readonly FrameRef[];
  readonly images?: readonly ImageSummary[];
}

function normalizeTrakeEvents(input: SearchLoopInput): string[] {
  if (input.task !== 'trake') {
    if (input.events?.length) throw new Error('events are only supported for trake');
    return [];
  }
  return parseExplicitTrakeEvents(input.events);
}

export function parseExplicitTrakeEvents(events: readonly string[] | undefined): string[] {
  if (!events || events.length < 1 || events.length > MAX_TRAKE_EVENTS) {
    throw new Error(`trake requires 1-${MAX_TRAKE_EVENTS} explicitly numbered event descriptions`);
  }

  return events.map((event, index) => {
    const match = event.trim().match(/^(\d+)[.)]\s+(.+)$/u);
    if (!match || Number(match[1]) !== index + 1 || !match[2].trim()) {
      throw new Error(`trake requires events numbered separately and sequentially from 1 to ${events.length}`);
    }
    return match[2].trim();
  });
}

function resultFrameRef(result: BackendSearchResult): FrameRef | null {
  const originalFrameId = result.original_frame_id ?? result.representative_frame?.original_frame_id;
  if (originalFrameId === null || originalFrameId === undefined) return null;
  return {
    videoId: result.video_id,
    originalFrameId,
    ...(result.representative_frame?.keyframe_no === undefined ? {} : { keyframeNo: result.representative_frame.keyframe_no }),
  };
}

function rankSearchResults(results: readonly BackendSearchResult[]): RankedFrame[] {
  return rankFrameCandidates(results.flatMap((result, index) => {
    const ref = resultFrameRef(result);
    return ref?.originalFrameId === undefined ? [] : [{
      videoId: ref.videoId,
      originalFrameId: ref.originalFrameId,
      ...(ref.keyframeNo === undefined ? {} : { keyframeNo: ref.keyframeNo }),
      score: result.score,
      sourceRank: index + 1,
    }];
  }));
}

export function summarizeFrame(frame: BackendFrame): FrameEvidenceSummary {
  return {
    videoId: frame.video_id,
    originalFrameId: frame.original_frame_id,
    keyframeNo: frame.keyframe_no,
    timestampMs: frame.timestamp_ms,
    thumbnailUri: frame.thumbnail_uri,
    captions: frame.captions.map((item) => item.text),
    ocr: frame.ocr.map((item) => item.text),
    objects: frame.objects.map((item) => item.label),
    asr: frame.asr_spans.map((item) => item.text),
    evidenceIds: [
      ...frame.captions.map((item) => item.evidence_id),
      ...frame.ocr.map((item) => item.evidence_id),
      ...frame.objects.map((item) => item.evidence_id),
      ...frame.asr_spans.map((item) => item.evidence_id),
    ],
  };
}

function mergeSearchResponses(current: BackendSearchResponse | undefined, next: BackendSearchResponse): BackendSearchResponse {
  if (!current) return next;
  const byKey = new Map<string, BackendSearchResult>();
  for (const result of [...current.results, ...next.results]) {
    const key = `${result.video_id}\u0000${result.original_frame_id ?? result.representative_frame?.original_frame_id ?? 'unknown'}\u0000${result.start_ms}`;
    const existing = byKey.get(key);
    if (!existing || result.score > existing.score) byKey.set(key, result);
  }
  return {
    ...next,
    query_id: next.query_id || current.query_id,
    confidence: (next.confidence?.score ?? 0) >= (current.confidence?.score ?? 0) ? next.confidence : current.confidence,
    results: [...byKey.values()].sort((left, right) => right.score - left.score).slice(0, 100),
    warnings: [...new Set([...current.warnings, ...next.warnings])],
  };
}

export function assessTrake(events: readonly string[], evidence: readonly FrameEvidenceSummary[]): TrakeCoverageReport {
  const framesByVideo = new Map<string, FrameEvidenceSummary[]>();
  for (const frame of evidence) {
    const frames = framesByVideo.get(frame.videoId) ?? [];
    framesByVideo.set(frame.videoId, [...frames, frame]);
  }
  let bestVideoId: string | undefined;
  let bestPath: TrakePath | undefined;
  for (const [videoId, frames] of framesByVideo) {
    const path = findBestTrakePath(events, frames);
    if (!bestPath || compareTrakePaths(path, bestPath) > 0 || (compareTrakePaths(path, bestPath) === 0 && videoId < (bestVideoId ?? '\uffff'))) {
      bestPath = path;
      bestVideoId = videoId;
    }
  }
  const coveredEvents = bestPath?.coveredEvents ?? [];
  const selectedFrames = bestPath?.selectedFrames ?? [];
  return {
    requiredEvents: [...events],
    coveredEvents: [...coveredEvents],
    missingEvents: events.map((_, index) => index).filter((index) => !coveredEvents.includes(index)),
    selectedFrames: selectedFrames.map((frame) => ({ ...frame })),
    chronological: isChronologicalTrakePath(selectedFrames),
    ...(bestVideoId === undefined || selectedFrames.length === 0 ? {} : { videoId: bestVideoId }),
  };
}

interface TrakePath {
  readonly coveredEvents: readonly number[];
  readonly selectedFrames: readonly FrameRef[];
  readonly score: number;
  readonly lastFrameId?: number;
}

function findBestTrakePath(events: readonly string[], frames: readonly FrameEvidenceSummary[]): TrakePath {
  const orderedFrames = [...frames].sort((left, right) => left.originalFrameId - right.originalFrameId || left.timestampMs - right.timestampMs);
  let paths = new Map<string, TrakePath>([['start', { coveredEvents: [], selectedFrames: [], score: 0 }]]);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const nextPaths = new Map(paths);
    for (const path of paths.values()) {
      for (const frame of orderedFrames) {
        if (path.lastFrameId !== undefined && frame.originalFrameId <= path.lastFrameId) continue;
        const score = trakeEventScore(events[eventIndex], frame);
        if (score === 0) continue;
        const candidate: TrakePath = {
          coveredEvents: [...path.coveredEvents, eventIndex],
          selectedFrames: [...path.selectedFrames, toFrameRef(frame)],
          score: path.score + score,
          lastFrameId: frame.originalFrameId,
        };
        const key = String(frame.originalFrameId);
        const existing = nextPaths.get(key);
        if (!existing || compareTrakePaths(candidate, existing) > 0) nextPaths.set(key, candidate);
      }
    }
    paths = nextPaths;
  }
  return [...paths.values()].reduce((best, path) => compareTrakePaths(path, best) > 0 ? path : best);
}

function compareTrakePaths(left: TrakePath, right: TrakePath): number {
  if (left.coveredEvents.length !== right.coveredEvents.length) return left.coveredEvents.length - right.coveredEvents.length;
  if (left.score !== right.score) return left.score - right.score;
  for (let index = 0; index < Math.min(left.coveredEvents.length, right.coveredEvents.length); index += 1) {
    if (left.coveredEvents[index] !== right.coveredEvents[index]) return right.coveredEvents[index] - left.coveredEvents[index];
  }
  const length = Math.min(left.selectedFrames.length, right.selectedFrames.length);
  for (let index = 0; index < length; index += 1) {
    const leftFrame = left.selectedFrames[index].originalFrameId ?? Number.MAX_SAFE_INTEGER;
    const rightFrame = right.selectedFrames[index].originalFrameId ?? Number.MAX_SAFE_INTEGER;
    if (leftFrame !== rightFrame) return rightFrame - leftFrame;
  }
  return 0;
}

function trakeEventScore(event: string, frame: FrameEvidenceSummary): number {
  const text = [...frame.captions, ...frame.ocr, ...frame.objects, ...frame.asr].join(' ').toLocaleLowerCase();
  return meaningfulTerms(event).filter((term) => text.includes(term)).length;
}

function toFrameRef(frame: FrameEvidenceSummary): FrameRef {
  return {
    videoId: frame.videoId,
    originalFrameId: frame.originalFrameId,
    ...(frame.keyframeNo === null ? {} : { keyframeNo: frame.keyframeNo }),
  };
}

function isChronologicalTrakePath(frames: readonly FrameRef[]): boolean {
  return frames.every((frame, index) => {
    if (index === 0) return true;
    const previous = frames[index - 1];
    return previous !== undefined
      && frame.videoId === previous.videoId
      && frame.originalFrameId !== undefined
      && previous.originalFrameId !== undefined
      && frame.originalFrameId > previous.originalFrameId;
  });
}

function selectVqaFrame(evidence: readonly FrameEvidenceSummary[], answered: ReadonlySet<string>): FrameEvidenceSummary | undefined {
  return evidence.find((frame) => !answered.has(frameKey(frame))) ?? evidence[0];
}

function appendUniqueFrames(existing: readonly FrameRef[], additions: readonly FrameRef[]): FrameRef[] {
  const result = existing.map((frame) => ({ ...frame }));
  const keys = new Set(result.map(frameKey));
  for (const frame of additions) {
    const key = frameKey(frame);
    if (keys.has(key)) continue;
    keys.add(key);
    result.push({ ...frame });
  }
  return result;
}

function frameKey(frame: { readonly videoId: string; readonly originalFrameId?: number; readonly keyframeNo?: number | null }): string {
  return `${frame.videoId}\u0000${frame.originalFrameId === undefined ? `keyframe:${frame.keyframeNo ?? 'unknown'}` : frame.originalFrameId}`;
}

function meaningfulTerms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/u).filter((term) => term.length > 2))];
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
