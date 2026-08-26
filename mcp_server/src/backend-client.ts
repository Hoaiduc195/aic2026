import {
  parseCandidatePageResponse,
  parseFrameResponse,
  parseHealthResponse,
  parsePlanResponse,
  parsePlaybackResponse,
  parseSearchResponse,
  parseSelectionResponse,
  parseStudioResponse,
  parseSubmissionPreviewResponse,
  parseVideoFramesResponse,
  parseVqaAnswerResponse,
} from './backend-response.js';
import { toFrameQuery } from './validation.js';
import type {
  BackendClientPort,
  BackendHealth,
  BackendFrame,
  BackendCandidatePage,
  BackendRetrievalPlan,
  BackendSearchResponse,
  BackendSelection,
  BackendSubmissionPreview,
  BackendStudio,
  BackendVideoFrames,
  BackendVideoPlayback,
  BackendVqaAnswer,
  CandidatePageInput,
  EmbeddingConfig,
  ExactFrameSearchInput,
  FrameImage,
  FrameRef,
  PlanSearchInput,
  SearchFramesInput,
  SubmissionPreviewInput,
  VqaAnswerInput,
} from './types.js';

export interface BackendClientOptions {
  readonly baseUrl: string;
  readonly operatorToken?: string;
  readonly timeoutMs: number;
  readonly maxImageBytes?: number;
  readonly embedding?: EmbeddingConfig;
  readonly fetcher?: typeof fetch;
}

export class BackendRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Backend request failed (${status})`);
    this.name = 'BackendRequestError';
    this.status = status;
  }
}

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export class BackendClient implements BackendClientPort {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxImageBytes: number;
  private readonly embedding?: EmbeddingConfig;

  constructor(private readonly options: BackendClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs;
    this.maxImageBytes = options.maxImageBytes ?? 12 * 1024 * 1024;
    this.embedding = options.embedding;
  }

  async searchFrames(input: SearchFramesInput): Promise<BackendSearchResponse> {
    return parseSearchResponse(await this.requestJson('/v1/search', {
      method: 'POST',
      body: JSON.stringify(await this.searchPayload(input)),
    }));
  }

  async planSearch(input: PlanSearchInput): Promise<BackendRetrievalPlan> {
    return parsePlanResponse(await this.requestJson('/v1/search/plan', {
      method: 'POST',
      body: JSON.stringify(await this.searchPayload(input)),
    }));
  }

  async searchExactFrames(input: ExactFrameSearchInput): Promise<BackendSearchResponse> {
    const frames = [];
    for (const frame of input.frames) {
      const resolved = await this.resolveFrame(frame);
      frames.push(toFrameQuery(resolved));
    }
    return parseSearchResponse(await this.requestJson('/v1/search/exact-frames', {
      method: 'POST',
      body: JSON.stringify({
        task: input.task,
        frames,
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
      }),
    }));
  }

  async getFrame(ref: FrameRef): Promise<BackendFrame> {
    if (ref.keyframeNo !== undefined) {
      return parseFrameResponse(await this.requestJson(
        `/v1/videos/${encodeURIComponent(ref.videoId)}/keyframes/${ref.keyframeNo}`,
      ));
    }
    const resolved = await this.resolveFrame(ref);
    return parseFrameResponse(await this.requestJson(
      `/v1/videos/${encodeURIComponent(resolved.videoId)}/frames/${resolved.originalFrameId}`,
    ));
  }

  async getFrameImage(ref: FrameRef): Promise<FrameImage> {
    const frame = await this.getFrame(ref);
    return this.requestImage(`/v1/videos/${encodeURIComponent(frame.video_id)}/frames/${frame.original_frame_id}/thumbnail`);
  }

  async getNearbyFrames(videoId: string, centerFrameId: number, limit: number): Promise<BackendVideoFrames> {
    const params = new URLSearchParams({ center_frame_id: String(centerFrameId), limit: String(limit) });
    return parseVideoFramesResponse(await this.requestJson(
      `/v1/videos/${encodeURIComponent(videoId)}/frames?${params.toString()}`,
    ));
  }

  async getVideo(videoId: string): Promise<BackendVideoPlayback> {
    return parsePlaybackResponse(await this.requestJson(`/v1/videos/${encodeURIComponent(videoId)}/playback`));
  }

  async getStudio(videoId: string): Promise<BackendStudio> {
    return parseStudioResponse(await this.requestJson(`/v1/videos/${encodeURIComponent(videoId)}/studio`));
  }

  async getVqaAnswer(input: VqaAnswerInput): Promise<BackendVqaAnswer> {
    const frame = await this.resolveFrame(input.frame);
    return parseVqaAnswerResponse(await this.requestJson('/v1/vqa/answer', {
      method: 'POST',
      body: JSON.stringify({
        query_id: input.queryId,
        question: input.question,
        video_id: frame.videoId,
        original_frame_id: frame.originalFrameId,
      }),
    }));
  }

  async getCandidates(input: CandidatePageInput): Promise<BackendCandidatePage> {
    const params = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    return parseCandidatePageResponse(await this.requestJson(
      `/v1/queries/${encodeURIComponent(input.queryId)}/candidates?${params.toString()}`,
    ));
  }

  async getSelection(queryId: string): Promise<BackendSelection | null> {
    return parseSelectionResponse(await this.requestJson(`/v1/queries/${encodeURIComponent(queryId)}/selection`));
  }

  async previewSubmission(input: SubmissionPreviewInput): Promise<BackendSubmissionPreview> {
    return parseSubmissionPreviewResponse(await this.requestJson('/v1/submissions/preview', {
      method: 'POST',
      body: JSON.stringify({
        query_id: input.queryId,
        task: input.task,
        answers: input.answers.map((answer) => ({
          video_id: answer.videoId,
          ...(Object.prototype.hasOwnProperty.call(answer, 'frameIds')
            ? { frame_ids: (answer as { readonly frameIds: readonly number[] }).frameIds }
            : { frame_id: (answer as { readonly frameId: number }).frameId }),
          ...('answer' in answer ? { answer: answer.answer } : {}),
        })),
      }),
    }));
  }

  async getHealth(): Promise<BackendHealth> {
    return parseHealthResponse(await this.requestJson('/health'));
  }

  private async resolveFrame(ref: FrameRef): Promise<FrameRef & { readonly originalFrameId: number }> {
    if (ref.originalFrameId !== undefined) return { ...ref, originalFrameId: ref.originalFrameId };
    if (ref.keyframeNo === undefined) throw new Error('frame reference is missing an identifier');
    const frame = parseFrameResponse(await this.requestJson(
      `/v1/videos/${encodeURIComponent(ref.videoId)}/keyframes/${ref.keyframeNo}`,
    ));
    return { videoId: ref.videoId, keyframeNo: ref.keyframeNo, originalFrameId: frame.original_frame_id };
  }

  private async searchPayload(input: SearchFramesInput): Promise<Record<string, unknown>> {
    const resolvedFrameQuery = input.frameQuery ? await this.resolveFrame(input.frameQuery) : undefined;
    const embedding = this.embedding;
    return {
      query: input.query,
      task: input.task,
      top_k: input.topK,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(resolvedFrameQuery ? { frame_query: toFrameQuery(resolvedFrameQuery) } : {}),
      ...(input.retrieval ? { retrieval: input.retrieval } : {}),
      ...(embedding ? {
        embedding: {
          base_url: embedding.baseUrl,
          ...(embedding.apiKey ? { api_key: embedding.apiKey } : {}),
          timeout_ms: embedding.timeoutMs,
        },
      } : {}),
    };
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new BackendRequestError(response.status);
    return payload;
  }

  private async requestImage(path: string): Promise<FrameImage> {
    const response = await this.request(path);
    if (!response.ok) throw new BackendRequestError(response.status);
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > this.maxImageBytes) {
      throw new Error('frame image exceeds configured size limit');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > this.maxImageBytes) throw new Error('frame image exceeds configured size limit');
    const mimeType = (response.headers.get('content-type') ?? 'image/jpeg').split(';', 1)[0].trim().toLowerCase();
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error('backend returned an unsupported image type');
    return { bytes, mimeType: mimeType as FrameImage['mimeType'] };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (this.options.operatorToken) headers.set('x-operator-token', this.options.operatorToken);
    return this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
