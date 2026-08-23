import type {
  BackendAsrSpan,
  BackendCandidate,
  BackendCandidatePage,
  BackendCaption,
  BackendFrame,
  BackendHealth,
  BackendObject,
  BackendOcr,
  BackendRetrievalPlan,
  BackendSelection,
  BackendSearchResponse,
  BackendSearchResult,
  BackendSubmissionPreview,
  BackendStudio,
  BackendVideoFrames,
  BackendVideoPlayback,
  BackendVqaAnswer,
} from './types.js';

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be text`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function integer(value: unknown, field: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) throw new Error(`${field} must be a valid integer`);
  return value as number;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function textArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${field} must be an array of text`);
  return value.map((item) => item as string);
}

function recordArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => ({ ...record(item, `${field}[${index}]`) }));
}

function optionalNullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field);
}

function textMap(value: unknown, field: string): Record<string, string> {
  const object = record(value, field);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, text(item, `${field}.${key}`)]));
}

function numberMap(value: unknown, field: string): Record<string, number> {
  const object = record(value, field);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, finite(item, `${field}.${key}`)]));
}

function parseEvidence(value: unknown, field: string) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const object = record(item, `${field}[${index}]`);
    return {
      evidence_id: text(object.evidence_id, `${field}[${index}].evidence_id`),
      type: text(object.type, `${field}[${index}].type`),
      ...(object.start_ms === undefined ? {} : { start_ms: integer(object.start_ms, `${field}[${index}].start_ms`) }),
      ...(object.end_ms === undefined ? {} : { end_ms: integer(object.end_ms, `${field}[${index}].end_ms`) }),
      ...(object.snippet === null ? { snippet: null } : { snippet: optionalText(object.snippet) ?? null }),
      producer: text(object.producer, `${field}[${index}].producer`),
    };
  });
}

function parseSearchResult(value: unknown, index: number): BackendSearchResult {
  const object = record(value, `results[${index}]`);
  const representativeValue = object.representative_frame;
  const representative = representativeValue === null || representativeValue === undefined
    ? representativeValue as null | undefined
    : (() => {
      const frame = record(representativeValue, `results[${index}].representative_frame`);
      return {
        ...(frame.keyframe_no === undefined ? {} : { keyframe_no: integer(frame.keyframe_no, 'keyframe_no', true) }),
        original_frame_id: integer(frame.original_frame_id, 'original_frame_id'),
        timestamp_ms: integer(frame.timestamp_ms, 'timestamp_ms'),
        ...(frame.preview_uri === null ? { preview_uri: null } : { preview_uri: optionalText(frame.preview_uri) ?? null }),
      };
    })();
  return {
    video_id: text(object.video_id, `results[${index}].video_id`),
    original_frame_id: object.original_frame_id === null || object.original_frame_id === undefined
      ? null
      : integer(object.original_frame_id, `results[${index}].original_frame_id`),
    start_ms: integer(object.start_ms, `results[${index}].start_ms`),
    end_ms: integer(object.end_ms, `results[${index}].end_ms`),
    preview_uri: text(object.preview_uri, `results[${index}].preview_uri`),
    score: finite(object.score, `results[${index}].score`),
    ...(representative === undefined ? {} : { representative_frame: representative }),
    evidence_ids: textArray(object.evidence_ids ?? [], `results[${index}].evidence_ids`),
    evidence: parseEvidence(object.evidence, `results[${index}].evidence`),
    matched_modalities: textArray(object.matched_modalities ?? [], `results[${index}].matched_modalities`),
  };
}

export function parseSearchResponse(value: unknown): BackendSearchResponse {
  const object = record(value, 'search response');
  const confidenceValue = object.confidence;
  const confidence = confidenceValue === undefined || confidenceValue === null
    ? undefined
    : (() => {
      const item = record(confidenceValue, 'confidence');
      const level = text(item.level, 'confidence.level');
      if (!['high', 'medium', 'low', 'unknown'].includes(level)) throw new Error('confidence.level is invalid');
      const action = item.action === undefined ? undefined : text(item.action, 'confidence.action');
      if (action !== undefined && !['return', 'expand', 'clarify', 'abstain'].includes(action)) throw new Error('confidence.action is invalid');
      return {
        level: level as NonNullable<BackendSearchResponse['confidence']>['level'],
        score: finite(item.score, 'confidence.score'),
        ...(action === undefined ? {} : { action: action as NonNullable<BackendSearchResponse['confidence']>['action'] }),
      };
    })();
  return {
    ...(object.request_id === undefined ? {} : { request_id: text(object.request_id, 'request_id') }),
    query_id: text(object.query_id, 'query_id'),
    ...(confidence === undefined ? {} : { confidence }),
    results: Array.isArray(object.results) ? object.results.map(parseSearchResult) : (() => { throw new Error('results must be an array'); })(),
    warnings: object.warnings === undefined ? [] : textArray(object.warnings, 'warnings'),
  };
}

function parseCaption(value: unknown, field: string): BackendCaption {
  const object = record(value, field);
  return { evidence_id: text(object.evidence_id, `${field}.evidence_id`), text: text(object.text, `${field}.text`), language: text(object.language, `${field}.language`), producer: text(object.producer, `${field}.producer`) };
}

function parseOcr(value: unknown, field: string): BackendOcr {
  return parseCaption(value, field);
}

function parseObject(value: unknown, field: string): BackendObject {
  const object = record(value, field);
  const bbox = object.normalized_bbox;
  if (bbox !== null && (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((item) => typeof item !== 'number' || item < 0 || item > 1))) {
    throw new Error(`${field}.normalized_bbox is invalid`);
  }
  return {
    evidence_id: text(object.evidence_id, `${field}.evidence_id`),
    label: text(object.label, `${field}.label`),
    confidence: finite(object.confidence, `${field}.confidence`),
    normalized_bbox: bbox === null ? null : [bbox[0] as number, bbox[1] as number, bbox[2] as number, bbox[3] as number],
    producer: text(object.producer, `${field}.producer`),
  };
}

function parseAsr(value: unknown, field: string): BackendAsrSpan {
  const object = record(value, field);
  return {
    evidence_id: text(object.evidence_id, `${field}.evidence_id`),
    start_ms: integer(object.start_ms, `${field}.start_ms`),
    end_ms: integer(object.end_ms, `${field}.end_ms`),
    text: text(object.text, `${field}.text`),
    language: text(object.language, `${field}.language`),
    producer: text(object.producer, `${field}.producer`),
  };
}

function parseFrame(value: unknown, field: string): BackendFrame {
  const object = record(value, field);
  if (object.is_exact_frame !== true) throw new Error(`${field}.is_exact_frame must be true`);
  return {
    video_id: text(object.video_id, `${field}.video_id`),
    keyframe_no: object.keyframe_no === null || object.keyframe_no === undefined ? null : integer(object.keyframe_no, `${field}.keyframe_no`, true),
    original_frame_id: integer(object.original_frame_id, `${field}.original_frame_id`),
    timestamp_ms: integer(object.timestamp_ms, `${field}.timestamp_ms`),
    captions: Array.isArray(object.captions) ? object.captions.map((item, index) => parseCaption(item, `${field}.captions[${index}]`)) : [],
    ocr: Array.isArray(object.ocr) ? object.ocr.map((item, index) => parseOcr(item, `${field}.ocr[${index}]`)) : [],
    objects: Array.isArray(object.objects) ? object.objects.map((item, index) => parseObject(item, `${field}.objects[${index}]`)) : [],
    thumbnail_uri: object.thumbnail_uri === null || object.thumbnail_uri === undefined ? null : text(object.thumbnail_uri, `${field}.thumbnail_uri`),
    is_exact_frame: true,
    annotation_source_frame_id: object.annotation_source_frame_id === null || object.annotation_source_frame_id === undefined ? null : integer(object.annotation_source_frame_id, `${field}.annotation_source_frame_id`),
    asr_spans: Array.isArray(object.asr_spans) ? object.asr_spans.map((item, index) => parseAsr(item, `${field}.asr_spans[${index}]`)) : [],
  };
}

function parsePlayback(value: unknown, field: string): BackendVideoPlayback {
  const object = record(value, field);
  const mime = text(object.mime_type, `${field}.mime_type`);
  if (!['video/mp4', 'video/webm', 'video/ogg'].includes(mime)) throw new Error(`${field}.mime_type is invalid`);
  return {
    video_id: text(object.video_id, `${field}.video_id`),
    playback_uri: text(object.playback_uri, `${field}.playback_uri`),
    duration_ms: integer(object.duration_ms, `${field}.duration_ms`),
    fps: finite(object.fps, `${field}.fps`),
    ...(object.frame_count === undefined || object.frame_count === null ? {} : { frame_count: integer(object.frame_count, `${field}.frame_count`) }),
    mime_type: mime as BackendVideoPlayback['mime_type'],
  };
}

export function parseFrameResponse(value: unknown): BackendFrame {
  return parseFrame(value, 'frame');
}

export function parsePlaybackResponse(value: unknown): BackendVideoPlayback {
  return parsePlayback(value, 'playback');
}

export function parseVideoFramesResponse(value: unknown): BackendVideoFrames {
  const object = record(value, 'nearby frames');
  if (!Array.isArray(object.frames)) throw new Error('nearby frames.frames must be an array');
  return {
    video_id: text(object.video_id, 'nearby frames.video_id'),
    center_frame_id: integer(object.center_frame_id, 'nearby frames.center_frame_id'),
    frames: object.frames.map((item, index) => {
      const frame = record(item, `nearby frames.frames[${index}]`);
      return {
        video_id: text(frame.video_id, 'nearby frame.video_id'),
        keyframe_no: integer(frame.keyframe_no, 'nearby frame.keyframe_no', true),
        original_frame_id: integer(frame.original_frame_id, 'nearby frame.original_frame_id'),
        timestamp_ms: integer(frame.timestamp_ms, 'nearby frame.timestamp_ms'),
        thumbnail_uri: text(frame.thumbnail_uri, 'nearby frame.thumbnail_uri'),
      };
    }),
  };
}

export function parseStudioResponse(value: unknown): BackendStudio {
  const object = record(value, 'studio');
  if (!Array.isArray(object.frames)) throw new Error('studio.frames must be an array');
  return {
    video: parsePlayback(object.video, 'studio.video'),
    frames: object.frames.map((item, index) => {
      const frame = record(item, `studio.frames[${index}]`);
      return {
        video_id: text(frame.video_id, 'studio frame.video_id'),
        keyframe_no: integer(frame.keyframe_no, 'studio frame.keyframe_no', true),
        original_frame_id: integer(frame.original_frame_id, 'studio frame.original_frame_id'),
        timestamp_ms: integer(frame.timestamp_ms, 'studio frame.timestamp_ms'),
        captions: Array.isArray(frame.captions) ? frame.captions.map((item, child) => parseCaption(item, `studio.frames[${index}].captions[${child}]`)) : [],
        ocr: Array.isArray(frame.ocr) ? frame.ocr.map((item, child) => parseOcr(item, `studio.frames[${index}].ocr[${child}]`)) : [],
        objects: Array.isArray(frame.objects) ? frame.objects.map((item, child) => parseObject(item, `studio.frames[${index}].objects[${child}]`)) : [],
      };
    }),
    asr_spans: Array.isArray(object.asr_spans) ? object.asr_spans.map((item, index) => parseAsr(item, `studio.asr_spans[${index}]`)) : [],
  };
}

export function parsePlanResponse(value: unknown): BackendRetrievalPlan {
  const object = record(value, 'search plan');
  const task = text(object.task, 'search plan.task');
  if (!['textual_kis', 'vqa', 'trake'].includes(task)) throw new Error('search plan.task is invalid');
  const atoms = recordArray(object.query_atoms ?? [], 'search plan.query_atoms').map((item, index) => ({
    id: text(item.id, `search plan.query_atoms[${index}].id`),
    type: text(item.type, `search plan.query_atoms[${index}].type`),
    value: text(item.value, `search plan.query_atoms[${index}].value`),
    weight: finite(item.weight, `search plan.query_atoms[${index}].weight`),
  }));
  const frameQueryValue = object.frame_query;
  const frameQuery = frameQueryValue === undefined || frameQueryValue === null
    ? undefined
    : (() => {
      const frame = record(frameQueryValue, 'search plan.frame_query');
      return {
        video_id: text(frame.video_id, 'search plan.frame_query.video_id'),
        original_frame_id: integer(frame.original_frame_id, 'search plan.frame_query.original_frame_id'),
      };
    })();
  const nearFrameWindow = object.near_frame_window_ms === undefined || object.near_frame_window_ms === null
    ? undefined
    : integer(object.near_frame_window_ms, 'search plan.near_frame_window_ms');
  return {
    query_id: text(object.query_id, 'search plan.query_id'),
    task: task as BackendRetrievalPlan['task'],
    language: text(object.language, 'search plan.language'),
    original_query: text(object.original_query, 'search plan.original_query'),
    ...(object.query_mode === undefined ? {} : { query_mode: text(object.query_mode, 'search plan.query_mode') }),
    ...(frameQuery ? { frame_query: frameQuery } : {}),
    query_variants: textArray(object.query_variants, 'search plan.query_variants'),
    concepts: textArray(object.concepts ?? [], 'search plan.concepts'),
    query_atoms: atoms,
    negative_concepts: textArray(object.negative_concepts ?? [], 'search plan.negative_concepts'),
    text_constraints: textArray(object.text_constraints ?? [], 'search plan.text_constraints'),
    audio_concepts: textArray(object.audio_concepts ?? [], 'search plan.audio_concepts'),
    object_terms: textArray(object.object_terms ?? [], 'search plan.object_terms'),
    object_constraints: { ...(object.object_constraints === undefined ? {} : record(object.object_constraints, 'search plan.object_constraints')) },
    query_views: textMap(object.query_views ?? {}, 'search plan.query_views'),
    channel_weights: numberMap(object.channel_weights ?? {}, 'search plan.channel_weights'),
    temporal_relations: textArray(object.temporal_relations ?? [], 'search plan.temporal_relations'),
    target_granularities: textArray(object.target_granularities ?? [], 'search plan.target_granularities'),
    branches: textArray(object.branches, 'search plan.branches'),
    top_k_per_branch: integer(object.top_k_per_branch, 'search plan.top_k_per_branch', true),
    fusion_k: integer(object.fusion_k, 'search plan.fusion_k', true),
    display_k: integer(object.display_k, 'search plan.display_k', true),
    ...(nearFrameWindow === undefined ? {} : { near_frame_window_ms: nearFrameWindow }),
    rrf_k: finite(object.rrf_k, 'search plan.rrf_k'),
    latency_budget_ms: integer(object.latency_budget_ms, 'search plan.latency_budget_ms', true),
    fallback_policy: text(object.fallback_policy, 'search plan.fallback_policy'),
    planner_version: text(object.planner_version, 'search plan.planner_version'),
    fusion: text(object.fusion, 'search plan.fusion'),
    index_version: text(object.index_version, 'search plan.index_version'),
    hard_filters: { ...(object.hard_filters === undefined ? {} : record(object.hard_filters, 'search plan.hard_filters')) },
    transformations: textArray(object.transformations ?? [], 'search plan.transformations'),
  };
}

export function parseVqaAnswerResponse(value: unknown): BackendVqaAnswer {
  const object = record(value, 'VQA answer');
  const status = text(object.answer_status, 'VQA answer.answer_status');
  if (!['answered', 'needs_more_evidence', 'abstained'].includes(status)) throw new Error('VQA answer.answer_status is invalid');
  const confidenceValue = record(object.confidence, 'VQA answer.confidence');
  const level = text(confidenceValue.level, 'VQA answer.confidence.level');
  if (!['low', 'medium', 'high'].includes(level)) throw new Error('VQA answer.confidence.level is invalid');
  return {
    result_id: text(object.result_id, 'VQA answer.result_id'),
    query_id: text(object.query_id, 'VQA answer.query_id'),
    video_id: text(object.video_id, 'VQA answer.video_id'),
    original_frame_id: integer(object.original_frame_id, 'VQA answer.original_frame_id'),
    timestamp_ms: integer(object.timestamp_ms, 'VQA answer.timestamp_ms'),
    answer_status: status as BackendVqaAnswer['answer_status'],
    answer: optionalNullableText(object.answer, 'VQA answer.answer'),
    normalized_answer: optionalNullableText(object.normalized_answer, 'VQA answer.normalized_answer'),
    evidence_ids: textArray(object.evidence_ids ?? [], 'VQA answer.evidence_ids'),
    confidence: { level: level as BackendVqaAnswer['confidence']['level'], score: finite(confidenceValue.score, 'VQA answer.confidence.score') },
    producer: text(object.producer, 'VQA answer.producer'),
    model_version: text(object.model_version, 'VQA answer.model_version'),
    ...(object.verification === undefined ? {} : { verification: { ...record(object.verification, 'VQA answer.verification') } }),
  };
}

function parseCandidate(value: unknown, index: number): BackendCandidate {
  const object = record(value, `candidate[${index}]`);
  return {
    rank: integer(object.rank, `candidate[${index}].rank`, true),
    video_id: text(object.video_id, `candidate[${index}].video_id`),
    original_frame_id: object.original_frame_id === null || object.original_frame_id === undefined ? null : integer(object.original_frame_id, `candidate[${index}].original_frame_id`),
    start_ms: integer(object.start_ms, `candidate[${index}].start_ms`),
    end_ms: integer(object.end_ms, `candidate[${index}].end_ms`),
    ...(object.preview_uri === undefined || object.preview_uri === null ? {} : { preview_uri: text(object.preview_uri, `candidate[${index}].preview_uri`) }),
    score: finite(object.score, `candidate[${index}].score`),
    evidence_ids: textArray(object.evidence_ids ?? [], `candidate[${index}].evidence_ids`),
    matched_modalities: textArray(object.matched_modalities ?? [], `candidate[${index}].matched_modalities`),
    fusion_trace: recordArray(object.fusion_trace ?? [], `candidate[${index}].fusion_trace`),
  };
}

export function parseCandidatePageResponse(value: unknown): BackendCandidatePage {
  const object = record(value, 'candidate page');
  return {
    query_id: text(object.query_id, 'candidate page.query_id'),
    total: integer(object.total, 'candidate page.total'),
    limit: integer(object.limit, 'candidate page.limit', true),
    offset: integer(object.offset, 'candidate page.offset'),
    candidates: Array.isArray(object.candidates) ? object.candidates.map(parseCandidate) : (() => { throw new Error('candidate page.candidates must be an array'); })(),
  };
}

export function parseSelectionResponse(value: unknown): BackendSelection | null {
  if (value === null) return null;
  const object = record(value, 'selection');
  const task = text(object.task, 'selection.task');
  if (!['textual_kis', 'vqa', 'trake'].includes(task)) throw new Error('selection.task is invalid');
  return {
    selection_id: text(object.selection_id, 'selection.selection_id'),
    query_id: text(object.query_id, 'selection.query_id'),
    revision: integer(object.revision, 'selection.revision', true),
    task: task as BackendSelection['task'],
    answers: recordArray(object.answers, 'selection.answers'),
    note: optionalNullableText(object.note, 'selection.note'),
    created_at: text(object.created_at, 'selection.created_at'),
  };
}

export function parseSubmissionPreviewResponse(value: unknown): BackendSubmissionPreview {
  const object = record(value, 'submission preview');
  const task = text(object.task, 'submission preview.task');
  if (!['textual_kis', 'vqa', 'trake'].includes(task)) throw new Error('submission preview.task is invalid');
  if (typeof object.submittable !== 'boolean') throw new Error('submission preview.submittable must be a boolean');
  return {
    query_id: text(object.query_id, 'submission preview.query_id'),
    task: task as BackendSubmissionPreview['task'],
    answer_count: integer(object.answer_count, 'submission preview.answer_count'),
    answers: recordArray(object.answers, 'submission preview.answers'),
    csv: text(object.csv, 'submission preview.csv'),
    submittable: object.submittable,
    warnings: textArray(object.warnings ?? [], 'submission preview.warnings'),
  };
}

export function parseHealthResponse(value: unknown): BackendHealth {
  const object = record(value, 'health');
  const dependencies = record(object.dependencies, 'health.dependencies');
  if (Object.values(dependencies).some((item) => typeof item !== 'string')) throw new Error('health.dependencies must contain text values');
  return {
    status: text(object.status, 'health.status'),
    service: text(object.service, 'health.service'),
    mode: text(object.mode, 'health.mode'),
    dependencies: Object.fromEntries(Object.entries(dependencies).map(([key, item]) => [key, item as string])),
    retrieval_branches: textArray(object.retrieval_branches, 'health.retrieval_branches'),
    task_executors: textArray(object.task_executors, 'health.task_executors'),
  };
}
