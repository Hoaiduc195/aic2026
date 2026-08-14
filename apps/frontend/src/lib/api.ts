import type {
  EvidenceType,
  CandidatePage,
  QualificationAnswer,
  QualificationTask,
  SearchEvidence,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchTask,
  SelectionRevision,
  SubmissionPreview,
  VideoFrame,
  VideoFramesResponse,
  VideoPlayback,
} from './contracts';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api';
const MODALITIES = new Set(['embedding', 'visual', 'ocr', 'asr', 'caption', 'object', 'temporal', 'audio']);
const EVIDENCE_TYPES = new Set<EvidenceType>(['frame', 'ocr', 'asr', 'caption', 'object', 'track', 'audio', 'temporal']);
const TASKS = new Set<SearchTask>(['textual_kis', 'video_kis', 'avs', 'vqa', 'trake', 'kisc']);

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function searchMedia(
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const response = await fetch(`${API_BASE}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isObject(payload) && typeof payload.message === 'string' ? payload.message : 'Tìm kiếm thất bại.';
    throw new ApiError(message, response.status);
  }

  return parseSearchResponse(payload);
}

export async function getVideoPlayback(videoId: string, frameId: number, signal?: AbortSignal): Promise<VideoPlayback> {
  const response = await fetch(`${API_BASE}/v1/videos/${encodeURIComponent(videoId)}/playback?frame_id=${frameId}`, { signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw apiError(payload, response.status, 'Không thể tải video.');
  return parseVideoPlayback(payload);
}

export async function getVideoFrames(
  videoId: string,
  centerFrameId: number,
  limit = 25,
  signal?: AbortSignal,
): Promise<VideoFramesResponse> {
  const response = await fetch(
    `${API_BASE}/v1/videos/${encodeURIComponent(videoId)}/frames?center_frame_id=${centerFrameId}&limit=${limit}`,
    { signal },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw apiError(payload, response.status, 'Không thể tải các frame cùng video.');
  return parseVideoFramesResponse(payload);
}

export async function getCandidates(
  queryId: string,
  limit = 100,
  offset = 0,
  signal?: AbortSignal,
): Promise<CandidatePage> {
  const response = await fetch(
    `${API_BASE}/v1/queries/${encodeURIComponent(queryId)}/candidates?limit=${limit}&offset=${offset}`,
    { signal },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw apiError(payload, response.status, 'Không thể tải candidates.');
  return parseCandidatePage(payload);
}

export async function getLatestSelection(queryId: string, signal?: AbortSignal): Promise<SelectionRevision | null> {
  const response = await fetch(`${API_BASE}/v1/queries/${encodeURIComponent(queryId)}/selection`, { signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw apiError(payload, response.status, 'Không thể tải selection.');
  return payload === null ? null : parseSelectionRevision(payload);
}

export async function saveSelection(
  queryId: string,
  task: QualificationTask,
  answers: readonly QualificationAnswer[],
  note?: string,
  signal?: AbortSignal,
): Promise<SelectionRevision> {
  const body = {
    task: toBackendTask(task),
    answers: [...answers],
    ...(note?.trim() ? { note: note.trim() } : {}),
  };
  const response = await fetch(`${API_BASE}/v1/queries/${encodeURIComponent(queryId)}/selection`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw apiError(payload, response.status, 'Không thể lưu selection.');
  return parseSelectionRevision(payload);
}

export async function createSubmissionPreview(
  queryId: string,
  task: QualificationTask,
  answers: readonly QualificationAnswer[],
  signal?: AbortSignal,
): Promise<SubmissionPreview> {
  const response = await fetch(`${API_BASE}/v1/submissions/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query_id: queryId, task: toBackendTask(task), answers: [...answers] }),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw apiError(payload, response.status, 'Không thể tạo submission preview.');
  return parseSubmissionPreview(payload);
}

export function parseVideoPlayback(value: unknown): VideoPlayback {
  if (!isObject(value)) throw new Error('playback response phải là object');
  const videoId = requiredText(value.video_id, 'video_id');
  const playbackUri = requiredBrowserUri(value.playback_uri, 'playback_uri');
  const durationMs = integer(value.duration_ms, 'duration_ms');
  const fps = positiveFinite(value.fps, 'fps');
  const mimeType = requiredText(value.mime_type, 'mime_type');
  if (!['video/mp4', 'video/webm', 'video/ogg'].includes(mimeType)) throw new Error('mime_type không hợp lệ');
  return {
    video_id: videoId,
    playback_uri: playbackUri,
    duration_ms: durationMs,
    fps,
    mime_type: mimeType as VideoPlayback['mime_type'],
  };
}

export function parseVideoFramesResponse(value: unknown): VideoFramesResponse {
  if (!isObject(value)) throw new Error('frames response phải là object');
  if (!Array.isArray(value.frames)) throw new Error('frames phải là array');
  return {
    video_id: requiredText(value.video_id, 'video_id'),
    center_frame_id: integer(value.center_frame_id, 'center_frame_id'),
    frames: value.frames.map(parseVideoFrame),
  };
}

export function parseCandidatePage(value: unknown): CandidatePage {
  if (!isObject(value)) throw new Error('candidates response phải là object');
  if (!Array.isArray(value.candidates)) throw new Error('candidates phải là array');
  return {
    query_id: requiredText(value.query_id, 'query_id'),
    total: nonNegativeInteger(value.total, 'total'),
    limit: positiveInteger(value.limit, 'limit'),
    offset: nonNegativeInteger(value.offset, 'offset'),
    candidates: value.candidates.map(parseCandidate),
  };
}

export function parseSelectionRevision(value: unknown): SelectionRevision {
  if (!isObject(value)) throw new Error('selection response phải là object');
  const task = parseQualificationTask(value.task, 'task');
  if (!Array.isArray(value.answers)) throw new Error('answers phải là array');
  return {
    selection_id: requiredText(value.selection_id, 'selection_id'),
    query_id: requiredText(value.query_id, 'query_id'),
    revision: positiveInteger(value.revision, 'revision'),
    task,
    answers: value.answers.map((answer, index) => parseQualificationAnswer(answer, task, index)),
    note: value.note === null ? null : optionalText(value.note) ?? null,
    created_at: value.created_at === undefined ? undefined : requiredText(value.created_at, 'created_at'),
  };
}

export function parseSubmissionPreview(value: unknown): SubmissionPreview {
  if (!isObject(value)) throw new Error('submission preview phải là object');
  const task = parseQualificationTask(value.task, 'task');
  if (!Array.isArray(value.answers)) throw new Error('answers phải là array');
  return {
    query_id: requiredText(value.query_id, 'query_id'),
    task,
    answer_count: nonNegativeInteger(value.answer_count, 'answer_count'),
    answers: value.answers.map((answer, index) => parseQualificationAnswer(answer, task, index)),
    csv: requiredText(value.csv, 'csv'),
    submittable: requiredBoolean(value.submittable, 'submittable'),
    warnings: stringArray(value.warnings ?? [], 'warnings'),
  };
}

export function parseSearchResponse(value: unknown): SearchResponse {
  if (!isObject(value)) {
    throw new Error('search response phải là object');
  }

  const queryId = requiredText(value.query_id, 'query_id');
  const rawResults = value.results;
  if (!Array.isArray(rawResults)) {
    throw new Error('results phải là array');
  }

  const response: SearchResponse = {
    request_id: optionalText(value.request_id),
    query_id: queryId,
    query: optionalText(value.query),
    session_id: value.session_id === null ? null : optionalText(value.session_id),
    task: optionalTask(value.task),
    task_executor: optionalText(value.task_executor),
    dataset_version: optionalText(value.dataset_version),
    pipeline_version: optionalText(value.pipeline_version),
    schema_version: optionalVersion(value.schema_version),
    index_version: optionalText(value.index_version),
    degraded: value.degraded === undefined ? false : requiredBoolean(value.degraded, 'degraded'),
    unavailable_branches: stringArray(value.unavailable_branches ?? [], 'unavailable_branches'),
    confidence: value.confidence === undefined ? undefined : parseConfidence(value.confidence),
    results: rawResults.map((result, index) => parseResult(result, index)),
    timing: isObject(value.timing) ? value.timing : undefined,
    warnings: value.warnings === undefined ? undefined : stringArray(value.warnings, 'warnings'),
  };

  return response;
}

function parseResult(value: unknown, index: number): SearchResult {
  if (!isObject(value)) {
    throw new Error(`results[${index}] phải là object`);
  }

  const start = integer(value.start_ms ?? value.timestamp_start_ms, `results[${index}].start_ms`);
  const end = integer(value.end_ms ?? value.timestamp_end_ms, `results[${index}].end_ms`);
  if (end <= start) {
    throw new Error(`results[${index}].end_ms phải lớn hơn start_ms`);
  }

  const evidenceIds = stringArray(value.evidence_ids ?? [], `results[${index}].evidence_ids`);
  const evidence = parseEvidence(value.evidence ?? [], index);
  const modalities = stringArray(value.matched_modalities ?? [], `results[${index}].matched_modalities`);
  if (modalities.some((modality) => !MODALITIES.has(modality))) {
    throw new Error(`results[${index}].matched_modalities chứa giá trị không hợp lệ`);
  }

  return {
    segment_id: requiredText(value.segment_id, `results[${index}].segment_id`),
    video_id: requiredText(value.video_id, `results[${index}].video_id`),
    start_ms: start,
    end_ms: end,
    preview_uri: requiredUri(value.preview_uri, `results[${index}].preview_uri`),
    score: finite(value.score, `results[${index}].score`),
    representative_frame: parseRepresentativeFrame(value.representative_frame, index),
    evidence_ids: evidenceIds,
    evidence,
    matched_modalities: modalities,
  };
}

function parseEvidence(value: unknown, resultIndex: number): SearchEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`results[${resultIndex}].evidence[${index}] phải là object`);
    }
    const type = requiredText(item.type, `results[${resultIndex}].evidence[${index}].type`);
    if (!EVIDENCE_TYPES.has(type as EvidenceType)) {
      throw new Error(`results[${resultIndex}].evidence[${index}].type không hợp lệ`);
    }
    const start = item.start_ms === undefined ? undefined : integer(item.start_ms, 'evidence.start_ms');
    const end = item.end_ms === undefined ? undefined : integer(item.end_ms, 'evidence.end_ms');
    if (start !== undefined && end !== undefined && end <= start) {
      throw new Error(`results[${resultIndex}].evidence[${index}] có interval không hợp lệ`);
    }
    return {
      evidence_id: requiredText(item.evidence_id, `results[${resultIndex}].evidence[${index}].evidence_id`),
      type: type as EvidenceType,
      start_ms: start,
      end_ms: end,
      snippet: item.snippet === null ? null : optionalText(item.snippet),
      producer: requiredText(item.producer, `results[${resultIndex}].evidence[${index}].producer`),
    };
  });
}

function parseRepresentativeFrame(value: unknown, resultIndex: number): SearchResult['representative_frame'] {
  if (value === undefined || value === null) {
    return value === null ? null : undefined;
  }
  if (!isObject(value)) {
    throw new Error(`results[${resultIndex}].representative_frame phải là object`);
  }
  return {
    original_frame_id: integer(value.original_frame_id, 'representative_frame.original_frame_id'),
    timestamp_ms: integer(value.timestamp_ms, 'representative_frame.timestamp_ms'),
    preview_uri: value.preview_uri === null ? null : optionalText(value.preview_uri),
  };
}

function parseVideoFrame(value: unknown, index: number): VideoFrame {
  if (!isObject(value)) throw new Error(`frames[${index}] phải là object`);
  return {
    video_id: requiredText(value.video_id, `frames[${index}].video_id`),
    keyframe_no: integer(value.keyframe_no, `frames[${index}].keyframe_no`),
    original_frame_id: integer(value.original_frame_id, `frames[${index}].original_frame_id`),
    timestamp_ms: integer(value.timestamp_ms, `frames[${index}].timestamp_ms`),
    thumbnail_uri: requiredBrowserUri(value.thumbnail_uri, `frames[${index}].thumbnail_uri`),
    evidence: value.evidence === undefined ? undefined : parseEvidence(value.evidence, index),
  };
}

function parseCandidate(value: unknown, index: number): CandidatePage['candidates'][number] {
  if (!isObject(value)) throw new Error(`candidates[${index}] phải là object`);
  return {
    rank: positiveInteger(value.rank, `candidates[${index}].rank`),
    segment_id: requiredText(value.segment_id, `candidates[${index}].segment_id`),
    video_id: requiredText(value.video_id, `candidates[${index}].video_id`),
    original_frame_id: value.original_frame_id === null ? null : nonNegativeInteger(value.original_frame_id, `candidates[${index}].original_frame_id`),
    start_ms: nonNegativeInteger(value.start_ms, `candidates[${index}].start_ms`),
    end_ms: positiveInteger(value.end_ms, `candidates[${index}].end_ms`),
    preview_uri: value.preview_uri === undefined ? undefined : requiredUri(value.preview_uri, `candidates[${index}].preview_uri`),
    score: finite(value.score, `candidates[${index}].score`),
    evidence_ids: stringArray(value.evidence_ids, `candidates[${index}].evidence_ids`),
    matched_modalities: stringArray(value.matched_modalities, `candidates[${index}].matched_modalities`),
  };
}

function parseQualificationTask(value: unknown, field: string): QualificationTask {
  if (value === 'textual_kis' || value === 'trake') return value;
  if (value === 'vqa') return 'qa';
  throw new Error(`${field} không hợp lệ`);
}

function parseQualificationAnswer(value: unknown, task: QualificationTask, index: number): QualificationAnswer {
  if (!isObject(value)) throw new Error(`answers[${index}] phải là object`);
  const videoId = requiredText(value.video_id, `answers[${index}].video_id`);
  if (task === 'trake') {
    if (!Array.isArray(value.frame_ids) || value.frame_ids.length < 1) throw new Error(`answers[${index}].frame_ids không hợp lệ`);
    return {
      video_id: videoId,
      frame_ids: value.frame_ids.map((frameId, frameIndex) => nonNegativeInteger(frameId, `answers[${index}].frame_ids[${frameIndex}]`)),
    };
  }
  const frameId = nonNegativeInteger(value.frame_id, `answers[${index}].frame_id`);
  if (task === 'qa') return { video_id: videoId, frame_id: frameId, answer: requiredText(value.answer, `answers[${index}].answer`) };
  return { video_id: videoId, frame_id: frameId };
}

function toBackendTask(task: QualificationTask): 'textual_kis' | 'vqa' | 'trake' {
  return task === 'qa' ? 'vqa' : task;
}

function parseConfidence(value: unknown): SearchResponse['confidence'] {
  if (!isObject(value)) {
    throw new Error('confidence phải là object');
  }
  const level = requiredText(value.level, 'confidence.level');
  if (!['high', 'medium', 'low', 'unknown'].includes(level)) {
    throw new Error('confidence.level không hợp lệ');
  }
  const score = probability(value.score, 'confidence.score');
  return {
    level: level as NonNullable<SearchResponse['confidence']>['level'],
    score,
    fallbacks_applied: value.fallbacks_applied === undefined ? undefined : stringArray(value.fallbacks_applied, 'confidence.fallbacks_applied'),
    action: value.action === undefined ? undefined : requiredAction(value.action),
  };
}

function requiredAction(value: unknown): NonNullable<SearchResponse['confidence']>['action'] {
  if (typeof value !== 'string' || !['return', 'expand', 'clarify', 'abstain'].includes(value)) {
    throw new Error('confidence.action không hợp lệ');
  }
  return value as NonNullable<SearchResponse['confidence']>['action'];
}

function optionalTask(value: unknown): SearchTask | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !TASKS.has(value as SearchTask)) {
    throw new Error('task không hợp lệ');
  }
  return value as SearchTask;
}

function optionalVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('schema_version không hợp lệ');
  }
  return value;
}

function requiredUri(value: unknown, field: string): string {
  const uri = requiredText(value, field);
  if (!/^(file|s3|r2|gs|azure|https?):\/\/[^\s?#]+$/.test(uri)) {
    throw new Error(`${field} phải là storage URI hợp lệ`);
  }
  return uri;
}

function requiredBrowserUri(value: unknown, field: string): string {
  const uri = requiredText(value, field);
  if (!uri.startsWith('/') && !/^https?:\/\/[^\s]+$/i.test(uri)) {
    throw new Error(`${field} phải là URI trình duyệt hợp lệ`);
  }
  return uri;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} phải là text`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} phải là số nguyên không âm`);
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  return integer(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = integer(value, field);
  if (parsed <= 0) throw new Error(`${field} phải lớn hơn 0`);
  return parsed;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} phải là số hữu hạn`);
  return value;
}

function positiveFinite(value: unknown, field: string): number {
  const parsed = finite(value, field);
  if (parsed <= 0) throw new Error(`${field} phải lớn hơn 0`);
  return parsed;
}

function probability(value: unknown, field: string): number {
  const score = finite(value, field);
  if (score < 0 || score > 1) throw new Error(`${field} phải nằm trong [0, 1]`);
  return score;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} phải là boolean`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} phải là array text`);
  }
  return [...new Set(value as string[])];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apiError(payload: unknown, status: number, fallback: string): ApiError {
  const message = isObject(payload) && typeof payload.message === 'string' ? payload.message : fallback;
  return new ApiError(message, status);
}
