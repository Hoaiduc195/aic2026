import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { BackendClient } from './backend-client.js';
import { checkTrakeSequence, getFrameContextBatch, getVideoContext } from './context-service.js';
import { parseSubmissionCsv } from './csv-parser.js';
import { SearchLoopService } from './search-loop.js';
import { SearchSessionStore } from './session-store.js';
import {
  DEFAULT_FOCUS_FRAME_COUNT,
  selectRankedCsvFrames,
  TOTAL_CSV_ROW_COUNT,
} from './top-video.js';
import { parseToolLimit, taskSchema, videoIdSchema } from './validation.js';
import { TraceService } from './trace-service.js';
import type { AppConfig } from './config.js';
import type { BackendCandidatePage, BackendClientPort, FrameRef, SearchLoopInput, SubmissionAnswerInput, TaskType } from './types.js';
import type { TopVideoCandidate } from './top-video.js';

const frameRefInput = z.object({
  videoId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u),
  originalFrameId: z.number().int().nonnegative().optional(),
  keyframeNo: z.number().int().positive().optional(),
}).strict().refine(
  (value) => (value.originalFrameId === undefined) !== (value.keyframeNo === undefined),
  { message: 'exactly one of originalFrameId or keyframeNo is required' },
);

const taskInput = taskSchema.default('textual_kis');

const rankedFrameInput = z.object({
  videoId: videoIdSchema,
  originalFrameId: z.number().int().nonnegative(),
  score: z.number().finite().optional(),
  sourceRank: z.number().int().positive().optional(),
  timestampMs: z.number().finite().optional(),
}).strict();

export interface ToolDependencies {
  readonly backend: BackendClientPort;
  readonly trace: TraceService;
  readonly config: AppConfig;
  readonly loop: SearchLoopService;
  readonly sessions: SearchSessionStore;
}

export function registerTools(server: McpServer, dependencies: ToolDependencies): void {
  const { backend, trace, config, loop } = dependencies;

  server.registerTool('search_frames', {
    title: 'Search AIC frames',
    description: 'Search the AIC retrieval database for relevant video frames and evidence. Pass query in concise English; translate Vietnamese visual descriptions first because embedding and caption retrieval are English-optimized. This is read-only.',
    inputSchema: z.object({
      query: z.string().max(2000).default(''),
      task: taskInput,
      topK: z.number().int().positive().max(100).optional(),
      frameQuery: frameRefInput.optional(),
      sessionId: z.string().max(200).optional(),
      retrieval: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async ({ query, task, topK, frameQuery, sessionId, retrieval }) => {
    if (!query.trim() && !frameQuery) return errorResult('query or frameQuery is required');
    return successResult(await backend.searchFrames({
      query: query.trim(),
      task,
      topK: parseToolLimit(topK, config.maxResults),
      ...(frameQuery ? { frameQuery: frameQuery as FrameRef } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(retrieval ? { retrieval } : {}),
    }));
  });

  server.registerTool('plan_search', {
    title: 'Plan AIC search',
    description: 'Inspect the deterministic AIC retrieval plan, branches, query variants and constraints without executing retrieval. Pass query in concise English for the English-optimized embedding and caption indexes.',
    inputSchema: z.object({
      query: z.string().max(2000).default(''),
      task: taskInput,
      topK: z.number().int().positive().max(100).optional(),
      frameQuery: frameRefInput.optional(),
      sessionId: z.string().max(200).optional(),
      retrieval: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async ({ query, task, topK, frameQuery, sessionId, retrieval }) => {
    if (!query.trim() && !frameQuery) return errorResult('query or frameQuery is required');
    return successResult(await backend.planSearch({
      query: query.trim(),
      task,
      topK: parseToolLimit(topK, config.maxResults),
      ...(frameQuery ? { frameQuery: frameQuery as FrameRef } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(retrieval ? { retrieval } : {}),
    }));
  });

  server.registerTool('search_exact_frames', {
    title: 'Search exact AIC frames',
    description: 'Validate and retrieve exact source frames from AIC by video ID and frame ID.',
    inputSchema: z.object({
      task: taskInput,
      frames: z.array(frameRefInput).min(1).max(100),
      sessionId: z.string().max(200).optional(),
    }),
  }, async ({ task, frames, sessionId }) => successResult(await backend.searchExactFrames({
    task,
    frames: frames as FrameRef[],
    ...(sessionId ? { sessionId } : {}),
  })));

  server.registerTool('get_frame', {
    title: 'Get exact AIC frame',
    description: 'Get exact frame metadata and evidence. Supports ordinary source frame IDs and keyframe numbers.',
    inputSchema: frameRefInput,
  }, async (ref) => successResult(await backend.getFrame(ref as FrameRef)));

  server.registerTool('get_frame_image', {
    title: 'Fetch AIC frame image',
    description: 'Fetch an exact frame image through the backend/R2 path and return it as MCP image content.',
    inputSchema: frameRefInput,
  }, async (ref) => {
    const [frame, image] = await Promise.all([
      backend.getFrame(ref as FrameRef),
      backend.getFrameImage(ref as FrameRef),
    ]);
    return {
      content: [
        { type: 'image' as const, data: image.bytes.toString('base64'), mimeType: image.mimeType },
        { type: 'text' as const, text: JSON.stringify({ videoId: frame.video_id, originalFrameId: frame.original_frame_id, keyframeNo: frame.keyframe_no, mimeType: image.mimeType, bytes: image.bytes.length }) },
      ],
      structuredContent: { videoId: frame.video_id, originalFrameId: frame.original_frame_id, keyframeNo: frame.keyframe_no, mimeType: image.mimeType, bytes: image.bytes.length },
    };
  });

  server.registerTool('get_frame_context_batch', {
    title: 'Get batch AIC frame context',
    description: 'Load up to 100 exact frames with metadata and OCR, captions, objects and ASR. Set includeImages to return up to 20 image contents in the same response.',
    inputSchema: z.object({
      frames: z.array(frameRefInput).min(1).max(100),
      includeImages: z.boolean().optional(),
    }),
  }, async ({ frames, includeImages }) => {
    const batch = await getFrameContextBatch(backend, frames as FrameRef[], includeImages ?? false);
    return frameContextResult(batch);
  });

  server.registerTool('get_video', {
    title: 'Get AIC video',
    description: 'Get AIC video metadata and a signed playback URI.',
    inputSchema: z.object({ videoId: videoIdSchema }),
  }, async ({ videoId }) => successResult(await backend.getVideo(videoId)));

  server.registerTool('get_video_studio', {
    title: 'Get AIC video studio data',
    description: 'Get indexed keyframes and OCR, caption, object and ASR annotations for a video.',
    inputSchema: z.object({ videoId: videoIdSchema }),
  }, async ({ videoId }) => successResult(await backend.getStudio(videoId)));

  server.registerTool('get_video_context', {
    title: 'Get combined AIC video context',
    description: 'Read video playback metadata, studio annotations and optionally nearby frames in one call.',
    inputSchema: z.object({
      videoId: videoIdSchema,
      centerFrameId: z.number().int().nonnegative().optional(),
      nearbyLimit: z.number().int().positive().max(100).optional(),
      includeStudio: z.boolean().optional(),
    }),
  }, async ({ videoId, centerFrameId, nearbyLimit, includeStudio }) => successResult(await getVideoContext(backend, {
    videoId,
    ...(centerFrameId === undefined ? {} : { centerFrameId }),
    nearbyLimit: parseToolLimit(nearbyLimit, config.maxNearbyFrames),
    includeStudio: includeStudio ?? true,
  })));

  server.registerTool('get_nearby_frames', {
    title: 'Get nearby AIC frames',
    description: 'Get the nearest indexed frames before and after a source frame.',
    inputSchema: z.object({
      videoId: videoIdSchema,
      centerFrameId: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(100).optional(),
    }),
  }, async ({ videoId, centerFrameId, limit }) => successResult(await backend.getNearbyFrames(videoId, centerFrameId, parseToolLimit(limit, config.maxNearbyFrames))));

  server.registerTool('get_frame_evidence', {
    title: 'Get AIC frame evidence',
    description: 'Return normalized OCR, captions, objects, ASR and exact frame metadata for evidence tracing.',
    inputSchema: frameRefInput,
  }, async (ref) => {
    const frame = await backend.getFrame(ref as FrameRef);
    return successResult({
      videoId: frame.video_id,
      originalFrameId: frame.original_frame_id,
      keyframeNo: frame.keyframe_no,
      timestampMs: frame.timestamp_ms,
      captions: frame.captions,
      ocr: frame.ocr,
      objects: frame.objects,
      asrSpans: frame.asr_spans,
      thumbnailUri: frame.thumbnail_uri,
      evidenceIds: [
        ...frame.captions.map((item) => item.evidence_id),
        ...frame.ocr.map((item) => item.evidence_id),
        ...frame.objects.map((item) => item.evidence_id),
        ...frame.asr_spans.map((item) => item.evidence_id),
      ],
    });
  });

  server.registerTool('suggest_vqa_answer', {
    title: 'Suggest grounded VQA answer',
    description: 'Run the configured backend VQA answerer for one exact frame. This is a suggestion and must be checked against returned evidence.',
    inputSchema: z.object({
      queryId: videoIdSchema,
      question: z.string().trim().min(1).max(2000),
      frame: frameRefInput,
    }),
  }, async ({ queryId, question, frame }) => successResult(await backend.getVqaAnswer({ queryId, question, frame: frame as FrameRef })));

  server.registerTool('get_candidates', {
    title: 'Get persisted AIC candidates',
    description: 'Read the candidate page persisted for a retrieval query. This never changes manual selection.',
    inputSchema: z.object({
      queryId: videoIdSchema,
      limit: z.number().int().positive().max(1000).optional(),
      offset: z.number().int().nonnegative().max(1_000_000).optional(),
    }),
  }, async ({ queryId, limit, offset }) => successResult(await backend.getCandidates({ queryId, limit: limit ?? Math.min(config.maxResults, 100), offset: offset ?? 0 })));

  server.registerTool('get_selection', {
    title: 'Get current AIC selection',
    description: 'Read the latest manual selection for a query. This does not create or replace a selection.',
    inputSchema: z.object({ queryId: videoIdSchema }),
  }, async ({ queryId }) => successResult(await backend.getSelection(queryId)));

  const submissionAnswer = z.union([
    z.object({ videoId: videoIdSchema, frameId: z.number().int().nonnegative() }).strict(),
    z.object({ videoId: videoIdSchema, frameId: z.number().int().nonnegative(), answer: z.string().max(100) }).strict(),
    z.object({ videoId: videoIdSchema, frameIds: z.array(z.number().int().nonnegative()).min(1).max(20) }).strict(),
  ]);
  server.registerTool('preview_submission', {
    title: 'Preview AIC submission CSV',
    description: 'Validate answer rows and generate the organizer CSV preview. Submission remains disabled and no selection is written.',
    inputSchema: z.object({
      queryId: videoIdSchema,
      task: taskInput,
      answers: z.array(submissionAnswer).min(1).max(100),
    }),
  }, async ({ queryId, task, answers }) => {
    const normalized = answers as SubmissionAnswerInput[];
    const shapeValid = normalized.every((answer) => task === 'trake'
      ? 'frameIds' in answer
      : 'frameId' in answer && (task === 'vqa' ? 'answer' in answer : !('answer' in answer)));
    if (!shapeValid) return errorResult(`answers do not match task ${task}`);
    return successResult(await backend.previewSubmission({ queryId, task, answers: normalized }));
  });

  server.registerTool('prepare_top100_focus_csv', {
    title: 'Prepare top-100 CSV with focused segment',
    description: 'Return up to 100 ranked Textual KIS rows while placing a configurable focus count from one temporal segment of the strongest video first. The default focus count is 20; this is read-only and does not save or submit the file.',
    inputSchema: z.object({
      queryId: videoIdSchema,
      candidates: z.array(rankedFrameInput).max(100).optional(),
      focusCount: z.number().int().min(1).max(TOTAL_CSV_ROW_COUNT).optional(),
    }),
  }, async ({ queryId, candidates, focusCount }) => prepareTop100FocusCsv(backend, queryId, candidates ?? [], focusCount ?? DEFAULT_FOCUS_FRAME_COUNT));

  server.registerTool('parse_submission_csv', {
    title: 'Parse AIC submission CSV',
    description: 'Parse answer CSV rows safely, including quoted commas and multiline VQA answers, without writing files or submitting data.',
    inputSchema: z.object({
      task: taskInput,
      csv: z.string().max(1_000_000),
      hasHeader: z.boolean().optional(),
    }),
  }, async ({ task, csv, hasHeader }) => successResult(parseSubmissionCsv(task, csv, { hasHeader: hasHeader ?? false })));

  server.registerTool('compare_frames', {
    title: 'Compare AIC frames',
    description: 'Compare candidate images against a reference frame using the backend visual retrieval/ranking logic.',
    inputSchema: z.object({
      reference: frameRefInput,
      candidates: z.array(frameRefInput).min(1).max(100),
      task: taskInput,
    }),
  }, async ({ reference, candidates, task }) => successResult(await trace.compareFrames({ reference: reference as FrameRef, candidates: candidates as FrameRef[], task })));

  server.registerTool('rank_frames', {
    title: 'Rank AIC frames',
    description: 'Rank candidate frames by visual similarity to a reference or by matching retrieved evidence text.',
    inputSchema: z.object({
      query: z.string().max(2000).optional(),
      reference: frameRefInput.optional(),
      candidates: z.array(frameRefInput).min(1).max(100),
      task: taskInput,
    }),
  }, async ({ query, reference, candidates, task }) => successResult(await trace.rankFrames({
    ...(query ? { query } : {}),
    ...(reference ? { reference: reference as FrameRef } : {}),
    candidates: candidates as FrameRef[],
    task,
  })));

  server.registerTool('trace_answer', {
    title: 'Trace an AIC answer',
    description: 'Retrieve and trace AIC evidence for a question. Pass query in concise English and keep the original language only for the question/final answer. Use this first for VQA, KIS or TRAKE answer verification; do not infer unsupported facts.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(2000),
      task: taskInput,
      maxResults: z.number().int().positive().max(100).optional(),
      includeNearby: z.boolean().optional(),
      candidateFrames: z.array(frameRefInput).max(100).optional(),
    }),
  }, async ({ query, task, maxResults, includeNearby, candidateFrames }) => successResult(await trace.traceAnswer({
    query,
    task,
    ...(maxResults === undefined ? {} : { maxResults }),
    ...(includeNearby === undefined ? {} : { includeNearby }),
    ...(candidateFrames ? { candidateFrames: candidateFrames as FrameRef[] } : {}),
  })));

  server.registerTool('check_trake_sequence', {
    title: 'Check TRAKE frame sequence',
    description: 'Load exact frames and verify four event coverage, distinct frames and chronological order using the same deterministic logic as search_loop.',
    inputSchema: z.object({
      events: z.array(z.string().trim().min(1).max(2000)).length(4),
      frames: z.array(frameRefInput).min(1).max(20),
    }),
  }, async ({ events, frames }) => successResult(await checkTrakeSequence(backend, events, frames as FrameRef[])));

  server.registerTool('search_loop', {
    title: 'Run bounded AIC evidence search loop',
    description: 'Run a bounded, read-only retrieval loop using the query supplied by the agent: inspect the plan, search, load exact evidence, expand nearby frames, and optionally suggest VQA. Translate Vietnamese visual descriptions into concise English and improve the query before calling this tool. For TRAKE, exactly four English event descriptions are tracked for coverage, while backend retrieval receives only the main query.',
    inputSchema: z.object({
      sessionId: z.string().max(200).optional(),
      task: taskInput,
      query: z.string().trim().min(1).max(2000),
      question: z.string().trim().min(1).max(2000).optional(),
      events: z.array(z.string().trim().min(1).max(2000)).length(4).optional(),
      seedFrames: z.array(frameRefInput).max(100).optional(),
      maxIterations: z.number().int().min(1).max(8).optional(),
      maxToolCalls: z.number().int().min(1).max(50).optional(),
      timeBudgetMs: z.number().int().min(1000).max(120000).optional(),
      targetConfidence: z.number().min(0).max(1).optional(),
      includeImages: z.boolean().optional(),
    }),
  }, async (input) => {
    if (input.task === 'vqa' && !input.question) return errorResult('question is required for vqa search loop');
    if (input.task !== 'trake' && input.events) return errorResult('events are only supported for trake');
    const report = await loop.run({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      task: input.task,
      query: input.query,
      ...(input.question ? { question: input.question } : {}),
      ...(input.events ? { events: input.events } : {}),
      ...(input.seedFrames ? { seedFrames: input.seedFrames as FrameRef[] } : {}),
      ...(input.maxIterations === undefined ? {} : { maxIterations: input.maxIterations }),
      ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
      ...(input.timeBudgetMs === undefined ? {} : { timeBudgetMs: input.timeBudgetMs }),
      ...(input.targetConfidence === undefined ? {} : { targetConfidence: input.targetConfidence }),
      ...(input.includeImages === undefined ? {} : { includeImages: input.includeImages }),
    } satisfies SearchLoopInput);
    return successResult(report);
  });

  server.registerTool('get_search_session', {
    title: 'Get bounded search session',
    description: 'Read the in-memory progress and stop reason of a bounded search loop. Sessions expire automatically and never contain tokens or image bytes.',
    inputSchema: z.object({ sessionId: z.string().max(200) }),
  }, async ({ sessionId }) => {
    const session = dependencies.sessions.get(sessionId);
    return session ? successResult(session) : errorResult('search session was not found or expired');
  });

  server.registerTool('get_backend_health', {
    title: 'Get AIC backend health',
    description: 'Read backend dependency and retrieval branch status to explain degraded search results.',
    inputSchema: z.object({}),
  }, async () => successResult(await backend.getHealth()));
}

async function prepareTop100FocusCsv(
  backend: BackendClientPort,
  queryId: string,
  suppliedCandidates: readonly TopVideoCandidate[],
  focusCount: number,
) {
  const warnings: string[] = [];
  let persistedCandidates: TopVideoCandidate[] = [];
  try {
    persistedCandidates = toTopVideoCandidates(await backend.getCandidates({ queryId, limit: 100, offset: 0 }));
  } catch {
    if (suppliedCandidates.length === 0) return errorResult('candidate page is unavailable; no frames were supplied');
    warnings.push('candidate_page_unavailable_used_supplied_candidates');
  }

  const selection = selectRankedCsvFrames([...suppliedCandidates, ...persistedCandidates], focusCount);
  if (!selection) return errorResult('no valid exact frame candidates were found');
  if (selection.focusFrames.length !== focusCount) {
    return errorResult(`best video ${selection.focusVideoId} has only ${selection.focusFrames.length} frames in one segment; ${focusCount} focused frames were requested`);
  }
  if (selection.rows.length === 0) return errorResult('no ranked rows are available for CSV export');

  const answerFrames = selection.rows.filter((frame): frame is FrameRef & { readonly originalFrameId: number } => frame.originalFrameId !== undefined);
  if (answerFrames.length !== selection.rows.length) return errorResult('CSV export requires an originalFrameId for every selected frame');
  const answers = answerFrames.map((frame) => ({ videoId: frame.videoId, frameId: frame.originalFrameId }));
  let preview;
  try {
    preview = await backend.previewSubmission({ queryId, task: 'textual_kis', answers });
  } catch {
    return errorResult('submission CSV preview could not be generated');
  }

  return successResult({
    ...preview,
    focusVideoId: selection.focusVideoId,
    focusFrameCount: selection.focusFrames.length,
    requestedFocusCount: focusCount,
    rowCount: answers.length,
    targetRowCount: TOTAL_CSV_ROW_COUNT,
    rowsShortfall: Math.max(0, TOTAL_CSV_ROW_COUNT - answers.length),
    warnings: [...new Set([
      ...warnings,
      ...(answers.length < TOTAL_CSV_ROW_COUNT ? [`row_count_shortfall:${answers.length}/${TOTAL_CSV_ROW_COUNT}`] : []),
      ...preview.warnings,
    ])],
  });
}

function toTopVideoCandidates(page: BackendCandidatePage): TopVideoCandidate[] {
  return page.candidates.flatMap((candidate, index) => candidate.original_frame_id === null
    ? []
    : [{
        videoId: candidate.video_id,
        originalFrameId: candidate.original_frame_id,
        score: candidate.score,
        sourceRank: candidate.rank > 0 ? candidate.rank : index + 1,
        timestampMs: candidate.start_ms,
      }]);
}

function successResult(value: unknown) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text' as const, text }], structuredContent: asRecord(value) };
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }] };
}

function frameContextResult(batch: Awaited<ReturnType<typeof getFrameContextBatch>>) {
  const metadata = batch.frames.map((item) => ({
    ref: item.ref,
    ...(item.frame ? { frame: item.frame } : {}),
    ...(item.image ? { image: { mimeType: item.image.mimeType, bytes: item.image.bytes.length } } : {}),
    ...(item.error ? { error: item.error } : {}),
  }));
  const content: Array<
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  > = [
    { type: 'text', text: JSON.stringify({ frames: metadata, warnings: batch.warnings }) },
  ];
  for (const item of batch.frames) {
    if (!item.image) continue;
    content.push({ type: 'image', data: item.image.bytes.toString('base64'), mimeType: item.image.mimeType });
  }
  return { content, structuredContent: { frames: metadata, warnings: batch.warnings } };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
