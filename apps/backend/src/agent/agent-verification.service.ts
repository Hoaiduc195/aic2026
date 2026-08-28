import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { APP_CONFIG, DATABASE, QUERY_EMBEDDER } from '../common/tokens';
import type { BackendConfig } from '../common/config';
import type { SearchRequest, SearchResponse } from '../common/types';
import type { QueryEmbeddingProvider } from '../compute/model-ports';
import type { DatabaseClient } from '../database/database.client';
import { MediaService } from '../media/media.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import type {
  AgentScanMode, AgentStartOptions, VerificationJudgment, VerificationPendingBatch,
  VerificationTemporalFrame, VerificationVideo,
} from './agent-verification.types';

interface RunRow extends QueryResultRow {
  readonly run_id: string;
  readonly query_id: string;
  readonly task: SearchRequest['task'];
  readonly query_text: string;
  readonly index_version: string;
  readonly video_budget: number;
  readonly frame_batch_size: number;
  readonly scan_mode: AgentScanMode;
  readonly video_rank: unknown;
  readonly current_video_index: number;
  readonly current_frame_cursor: number | null;
  readonly pending_batch: unknown;
  readonly judgments: unknown;
  readonly videos_examined: number;
  readonly frames_examined: number;
  readonly frames_total: number;
  readonly status: 'running' | 'completed' | 'stopped' | 'failed';
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
  readonly query_embedding: unknown;
  readonly worker_id: string | null;
  readonly lease_expires_at: Date | string | null;
  readonly heartbeat_at: Date | string | null;
}

interface StoredJudgment extends VerificationJudgment {
  readonly judged_at: string;
}

function parseVideoRank(value: unknown): VerificationVideo[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is VerificationVideo => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate.video_id === 'string'
      && Number.isSafeInteger(candidate.video_rank)
      && typeof candidate.seed_score === 'number'
      && Array.isArray(candidate.seed_frames)
      && candidate.seed_frames.every((frame) => Number.isSafeInteger(frame))
      && (candidate.seed_timestamps_ms === undefined || (Array.isArray(candidate.seed_timestamps_ms)
        && candidate.seed_timestamps_ms.every((timestamp) => Number.isSafeInteger(timestamp))))
      && (candidate.temporal_frames === undefined || (Array.isArray(candidate.temporal_frames)
        && candidate.temporal_frames.every((frame) => {
          if (!frame || typeof frame !== 'object') return false;
          const temporal = frame as Record<string, unknown>;
          return Number.isSafeInteger(temporal.original_frame_id)
            && Number.isSafeInteger(temporal.timestamp_ms)
            && Number.isSafeInteger(temporal.window_id)
            && Number.isSafeInteger(temporal.window_start_ms)
            && Number.isSafeInteger(temporal.window_end_ms);
        })))
      && Number.isSafeInteger(candidate.frames_total);
  }).map((item) => ({
    video_id: item.video_id,
    video_rank: item.video_rank,
    seed_score: item.seed_score,
    seed_frames: [...item.seed_frames],
    seed_timestamps_ms: [...(item.seed_timestamps_ms ?? [])],
    temporal_frames: [...(item.temporal_frames ?? [])],
    frames_total: item.frames_total,
  }));
}

interface TemporalAnchor {
  readonly timestamp_ms: number;
  readonly score: number;
}

interface TemporalBuildOptions {
  readonly windowSeconds: number;
  readonly mergeGapSeconds: number;
  readonly windowsPerVideo: number;
  readonly sampleFps: number;
}

/** Build bounded, merged and uniformly sampled windows around retrieval hits. */
export function buildTemporalFrames(
  anchors: readonly TemporalAnchor[],
  metadata: { readonly fps: number; readonly frame_count: number; readonly duration_ms: number },
  options: TemporalBuildOptions,
): VerificationTemporalFrame[] {
  if (!Number.isFinite(metadata.fps) || metadata.fps <= 0 || metadata.frame_count <= 0) return [];
  const durationMs = Math.max(1, Math.min(
    Number.isFinite(metadata.duration_ms) && metadata.duration_ms > 0
      ? metadata.duration_ms
      : Math.round((metadata.frame_count / metadata.fps) * 1000),
    Math.round((metadata.frame_count / metadata.fps) * 1000),
  ));
  const radiusMs = options.windowSeconds * 1000;
  const mergeGapMs = options.mergeGapSeconds * 1000;
  const windows: Array<{ start_ms: number; end_ms: number; score: number }> = [];
  for (const anchor of [...anchors].sort((left, right) => right.score - left.score)) {
    if (!Number.isFinite(anchor.timestamp_ms)) continue;
    const candidate = {
      start_ms: Math.max(0, Math.round(anchor.timestamp_ms - radiusMs)),
      end_ms: Math.min(durationMs, Math.round(anchor.timestamp_ms + radiusMs)),
      score: anchor.score,
    };
    const overlap = windows.find((window) => {
      const touches = candidate.start_ms <= window.end_ms + mergeGapMs
        && candidate.end_ms >= window.start_ms - mergeGapMs;
      const mergedSpan = Math.max(window.end_ms, candidate.end_ms) - Math.min(window.start_ms, candidate.start_ms);
      // Prevent a chain of nearby hits from expanding one window across most of a video.
      return touches && mergedSpan <= (radiusMs * 2) + mergeGapMs;
    });
    if (overlap) {
      overlap.start_ms = Math.min(overlap.start_ms, candidate.start_ms);
      overlap.end_ms = Math.max(overlap.end_ms, candidate.end_ms);
      overlap.score = Math.max(overlap.score, candidate.score);
    } else if (windows.length < options.windowsPerVideo) {
      windows.push(candidate);
    }
  }
  const selected = windows
    .sort((left, right) => right.score - left.score)
    .slice(0, options.windowsPerVideo)
    .sort((left, right) => left.start_ms - right.start_ms);
  const frames = new Map<number, VerificationTemporalFrame>();
  selected.forEach((window, windowIndex) => {
    const step = metadata.fps / options.sampleFps;
    const first = Math.max(0, Math.ceil((window.start_ms / 1000) * metadata.fps));
    const last = Math.min(metadata.frame_count - 1, Math.floor((window.end_ms / 1000) * metadata.fps));
    for (let position = first; position <= last; position += step) {
      const frameId = Math.min(last, Math.round(position));
      frames.set(frameId, {
        original_frame_id: frameId,
        timestamp_ms: Math.round((frameId / metadata.fps) * 1000),
        window_id: windowIndex + 1,
        window_start_ms: window.start_ms,
        window_end_ms: window.end_ms,
      });
    }
  });
  return [...frames.values()].sort((left, right) => left.original_frame_id - right.original_frame_id);
}

function parsePendingBatch(value: unknown): VerificationPendingBatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.video_id !== 'string' || !Number.isSafeInteger(item.after_original_frame_id)
    || !Array.isArray(item.frame_ids) || !item.frame_ids.every((frame) => Number.isSafeInteger(frame))
    || typeof item.has_more !== 'boolean'
    || (item.next_cursor !== null && !Number.isSafeInteger(item.next_cursor))) return null;
  return {
    video_id: item.video_id,
    after_original_frame_id: item.after_original_frame_id as number,
    frame_ids: [...item.frame_ids] as number[],
    has_more: item.has_more,
    next_cursor: item.next_cursor as number | null,
  };
}

function parseJudgments(value: unknown): StoredJudgment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StoredJudgment => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate.video_id === 'string'
      && Number.isSafeInteger(candidate.original_frame_id)
      && typeof candidate.relevant === 'boolean'
      && typeof candidate.score === 'number'
      && typeof candidate.judged_at === 'string';
  }).map((item) => ({
    video_id: item.video_id,
    original_frame_id: item.original_frame_id,
    relevant: item.relevant,
    score: item.score,
    ...(item.reason ? { reason: item.reason } : {}),
    judged_at: item.judged_at,
  }));
}

@Injectable()
export class AgentVerificationService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseClient,
    @Inject(APP_CONFIG) private readonly config: BackendConfig,
    @Inject(QUERY_EMBEDDER) private readonly queryEmbedder: QueryEmbeddingProvider,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  async start(request: SearchRequest, options: AgentStartOptions) {
    this.assertDatabaseConfigured();
    const response = await this.retrieval.search({
      ...request,
      retrieval: {
        ...request.retrieval,
        branch_k: Math.max(request.retrieval?.branch_k ?? options.topK, options.topK),
        fusion_k: Math.max(request.retrieval?.fusion_k ?? options.topK, options.topK),
        display_k: options.topK,
        latency_budget_ms: Math.max(request.retrieval?.latency_budget_ms ?? 15_000, 15_000),
      },
    });
    if (response.results.length === 0 && response.degraded) {
      throw new ServiceUnavailableException(
        `coarse retrieval returned no candidates while branches were unavailable: ${response.unavailable_branches.join(', ')}`,
      );
    }
    const videos = await this.rankVideos(response, options.videoBudget, options);
    const queryEmbedding = await this.embedQueryForPrefilter(request.query);
    const runId = randomUUID();
    const status = videos.length === 0 ? 'completed' : 'running';
    const framesTotal = videos.reduce((sum, video) => sum + video.frames_total, 0);
    await this.database.query(`
      INSERT INTO agent_verification_runs (
        run_id, query_id, task, query_text, index_version, video_budget,
        frame_batch_size, scan_mode, video_rank, frames_total, status, completed_at, query_embedding
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
        CASE WHEN $11 = 'completed' THEN now() ELSE NULL END, $12::vector)`, [
      runId, response.query_id, request.task, request.query, response.index_version,
      options.videoBudget, options.frameBatchSize, options.scanMode, JSON.stringify(videos), framesTotal, status,
      queryEmbedding ? `[${queryEmbedding.join(',')}]` : null,
    ]);
    const run = await this.load(runId);
    return {
      run: this.summary(run),
      coarse_search: {
        query_id: response.query_id,
        top_k: options.topK,
        result_count: response.results.length,
        degraded: response.degraded,
        unavailable_branches: response.unavailable_branches,
      },
      videos: videos.map((video) => ({
        video_id: video.video_id,
        video_rank: video.video_rank,
        seed_score: video.seed_score,
        seed_frames: video.seed_frames,
        seed_timestamps_ms: video.seed_timestamps_ms,
        temporal_windows: [...new Set(video.temporal_frames.map((frame) => frame.window_id))].length,
        frames_total: video.frames_total,
      })),
    };
  }

  async get(runId: string) {
    this.assertDatabaseConfigured();
    const run = await this.load(runId);
    return this.resultResponse(run);
  }

  async nextBatch(runId: string, workerId?: string) {
    this.assertDatabaseConfigured();
    let run = await this.load(runId);
    this.assertLease(run, workerId);
    if (run.status !== 'running') return { run: this.summary(run), batch: null };

    const pending = parsePendingBatch(run.pending_batch);
    if (pending) return this.batchResponse(run, pending);

    const videos = parseVideoRank(run.video_rank);
    while (run.current_video_index < videos.length) {
      const video = videos[run.current_video_index];
      const after = run.current_frame_cursor ?? -1;
      const page = await this.framePage(run, video.video_id, after);
      if (page.frames.length === 0) {
        // An empty frame inventory was still examined and counts toward progress.
        await this.markVideoComplete(run);
        run = await this.load(runId);
        continue;
      }
      const next: VerificationPendingBatch = {
        video_id: video.video_id,
        after_original_frame_id: after,
        frame_ids: page.frames.map((frame) => frame.original_frame_id),
        has_more: page.has_more,
        next_cursor: page.next_cursor,
      };
      await this.database.query(`
        UPDATE agent_verification_runs
        SET pending_batch = $2::jsonb, updated_at = now()
        WHERE run_id = $1 AND status = 'running'`, [runId, JSON.stringify(next)]);
      run = await this.load(runId);
      return this.batchResponse(run, next);
    }

    await this.database.query(`
      UPDATE agent_verification_runs
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE run_id = $1 AND status = 'running'`, [runId]);
    return { run: this.summary(await this.load(runId)), batch: null };
  }

  async submit(runId: string, judgments: readonly VerificationJudgment[], workerId?: string) {
    this.assertDatabaseConfigured();
    if (judgments.length === 0) throw new BadRequestException('judgments must not be empty');
    const run = await this.load(runId);
    this.assertLease(run, workerId);
    if (run.status !== 'running') throw new BadRequestException(`run is ${run.status}`);
    const pending = parsePendingBatch(run.pending_batch);
    if (!pending) throw new BadRequestException('there is no pending batch to judge');
    const expected = new Set(pending.frame_ids);
    const actual = judgments.map((item) => item.original_frame_id);
    const actualSet = new Set(actual);
    const permitsRefinedFrames = run.scan_mode === 'temporal_zoom';
    if (actualSet.size !== judgments.length
      || [...expected].some((frame) => !actualSet.has(frame))
      || (!permitsRefinedFrames && (judgments.length !== expected.size || actual.some((frame) => !expected.has(frame))))
      || judgments.some((item) => item.video_id !== pending.video_id)) {
      throw new BadRequestException(
        'judgments must contain every pending frame exactly once; temporal zoom may append refined frames from the same video',
      );
    }
    const now = new Date().toISOString();
    const stored = judgments.map((item) => ({ ...item, judged_at: now }));
    await this.database.query(`
      INSERT INTO agent_verification_judgments (
        run_id, video_id, original_frame_id, relevant, score, reason, judged_at
      )
      SELECT $1, item.video_id, item.original_frame_id, item.relevant,
             item.score, item.reason, item.judged_at
      FROM jsonb_to_recordset($2::jsonb) AS item(
        video_id text,
        original_frame_id integer,
        relevant boolean,
        score real,
        reason text,
        judged_at timestamptz
      )
      ON CONFLICT (run_id, video_id, original_frame_id) DO UPDATE
      SET relevant = EXCLUDED.relevant,
          score = EXCLUDED.score,
          reason = EXCLUDED.reason,
          judged_at = EXCLUDED.judged_at`, [runId, JSON.stringify(stored)]);
    const nextCursor = pending.has_more ? pending.next_cursor : null;
    const nextVideoIndex = pending.has_more ? run.current_video_index : run.current_video_index + 1;
    const nextVideosExamined = pending.has_more ? run.videos_examined : run.videos_examined + 1;
    const completed = nextVideoIndex >= parseVideoRank(run.video_rank).length;
    await this.database.query(`
      UPDATE agent_verification_runs
      SET current_video_index = $2,
          current_frame_cursor = $3,
          pending_batch = 'null'::jsonb,
          videos_examined = $4,
          frames_examined = frames_examined + $5,
          status = CASE WHEN $6 THEN 'completed' ELSE 'running' END,
          completed_at = CASE WHEN $6 THEN now() ELSE NULL END,
          updated_at = now()
      WHERE run_id = $1 AND status = 'running'`, [
      runId, nextVideoIndex, nextCursor, nextVideosExamined, expected.size, completed,
    ]);
    return { run: this.summary(await this.load(runId)), accepted: stored.length };
  }

  async stop(runId: string) {
    this.assertDatabaseConfigured();
    const result = await this.database.query(
      `UPDATE agent_verification_runs SET status = 'stopped', updated_at = now(), completed_at = now()
       WHERE run_id = $1 AND status = 'running' RETURNING run_id`, [runId],
    );
    if (!result.rows[0]) {
      const run = await this.load(runId);
      return { ...(await this.resultResponse(run)), changed: false };
    }
    return { ...(await this.resultResponse(await this.load(runId))), changed: true };
  }

  async complete(runId: string, workerId?: string) {
    this.assertDatabaseConfigured();
    const run = await this.load(runId);
    this.assertLease(run, workerId);
    const result = await this.database.query(
      `UPDATE agent_verification_runs
       SET status = 'completed', pending_batch = 'null'::jsonb,
           completed_at = now(), updated_at = now()
       WHERE run_id = $1 AND status = 'running' RETURNING run_id`, [runId],
    );
    return { ...(await this.resultResponse(await this.load(runId))), changed: Boolean(result.rows[0]) };
  }

  async claim(runId: string, workerId: string, leaseMs = this.config.agentWorkerLeaseMs) {
    this.assertDatabaseConfigured();
    const boundedLeaseMs = Math.max(10_000, Math.min(300_000, leaseMs));
    const result = await this.database.query<RunRow>(`
      UPDATE agent_verification_runs
      SET worker_id = $2,
          heartbeat_at = now(),
          lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
          updated_at = now()
      WHERE run_id = $1
        AND status = 'running'
        AND (worker_id IS NULL OR worker_id = $2 OR lease_expires_at IS NULL OR lease_expires_at <= now())
      RETURNING *`, [runId, workerId, boundedLeaseMs]);
    const run = result.rows[0];
    if (run) return { run: this.summary(run), claimed: true };
    const existing = await this.load(runId);
    if (existing.status !== 'running') throw new BadRequestException(`run is ${existing.status}`);
    throw new ConflictException('verification run is leased by another worker');
  }

  async heartbeat(runId: string, workerId: string, leaseMs = this.config.agentWorkerLeaseMs) {
    this.assertDatabaseConfigured();
    const boundedLeaseMs = Math.max(10_000, Math.min(300_000, leaseMs));
    const result = await this.database.query<RunRow>(`
      UPDATE agent_verification_runs
      SET heartbeat_at = now(),
          lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
          updated_at = now()
      WHERE run_id = $1 AND worker_id = $2 AND status = 'running'
      RETURNING *`, [runId, workerId, boundedLeaseMs]);
    if (!result.rows[0]) throw new ConflictException('worker does not own this verification run');
    return { run: this.summary(result.rows[0]) };
  }

  async release(runId: string, workerId: string) {
    this.assertDatabaseConfigured();
    const result = await this.database.query<RunRow>(`
      UPDATE agent_verification_runs
      SET worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = now()
      WHERE run_id = $1 AND worker_id = $2
      RETURNING *`, [runId, workerId]);
    if (!result.rows[0]) throw new ConflictException('worker does not own this verification run');
    return { run: this.summary(result.rows[0]), released: true };
  }

  private async rankVideos(
    response: SearchResponse,
    budget: number,
    options: AgentStartOptions,
  ): Promise<VerificationVideo[]> {
    const scanMode = options.scanMode;
    const grouped = new Map<string, { score: number; frames: Set<number>; anchors: TemporalAnchor[] }>();
    for (const result of response.results) {
      const current = grouped.get(result.video_id) ?? {
        score: Number(result.score), frames: new Set<number>(), anchors: [],
      };
      current.score = Math.max(current.score, Number(result.score));
      if (result.original_frame_id !== null) current.frames.add(result.original_frame_id);
      const timestamp = result.representative_frame?.timestamp_ms ?? result.start_ms;
      if (Number.isFinite(timestamp)) current.anchors.push({ timestamp_ms: timestamp, score: Number(result.score) });
      grouped.set(result.video_id, current);
    }
    const ranked = [...grouped.entries()]
      .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
      .slice(0, budget);
    const frameCounts = scanMode === 'dense'
      ? await this.countRawFramesByVideo(ranked.map(([videoId]) => videoId))
      : scanMode === 'sparse'
        ? await this.countSparseFramesByVideo(ranked.map(([videoId]) => videoId))
        : new Map<string, number>();
    const result: VerificationVideo[] = [];
    for (const [videoId, value] of ranked) {
      const temporalFrames = scanMode === 'temporal_zoom'
        ? buildTemporalFrames(value.anchors, await this.media.getTemporalFrameMetadata(videoId), {
          windowSeconds: options.temporalWindowSeconds,
          mergeGapSeconds: options.temporalMergeGapSeconds,
          windowsPerVideo: options.temporalWindowsPerVideo,
          sampleFps: options.temporalSampleFps,
        })
        : [];
      result.push({
        video_id: videoId,
        video_rank: result.length + 1,
        seed_score: value.score,
        seed_frames: [...value.frames].slice(0, 10),
        seed_timestamps_ms: value.anchors.slice(0, 10).map((anchor) => Math.round(anchor.timestamp_ms)),
        temporal_frames: temporalFrames,
        frames_total: scanMode === 'temporal_zoom' ? temporalFrames.length : (frameCounts.get(videoId) ?? 0),
      });
    }
    return result;
  }

  private async countSparseFramesByVideo(videoIds: readonly string[]): Promise<Map<string, number>> {
    if (videoIds.length === 0) return new Map();
    const result = await this.database.query<{ video_id: string; count: string }>(
      `SELECT video_id, COUNT(*)::text AS count
       FROM frames
       WHERE video_id = ANY($1::text[])
       GROUP BY video_id`, [videoIds],
    );
    return new Map(result.rows.map((row) => [row.video_id, Number(row.count)]));
  }

  private async countRawFramesByVideo(videoIds: readonly string[]): Promise<Map<string, number>> {
    if (videoIds.length === 0) return new Map();
    const counts = new Map<string, number>();
    for (const videoId of videoIds) {
      counts.set(videoId, await this.media.ensureExactFrameCount(videoId));
    }
    return counts;
  }

  private framePage(run: RunRow, videoId: string, afterOriginalFrameId: number) {
    if (run.scan_mode === 'dense') {
      return this.media.getDenseFrameBatch(videoId, afterOriginalFrameId, run.frame_batch_size);
    }
    if (run.scan_mode === 'temporal_zoom') {
      const video = parseVideoRank(run.video_rank).find((item) => item.video_id === videoId);
      return this.media.getTemporalFrameBatch(videoId, video?.temporal_frames ?? [], afterOriginalFrameId, run.frame_batch_size);
    }
    return this.media.getFrameBatch(videoId, afterOriginalFrameId, run.frame_batch_size);
  }

  private async batchResponse(run: RunRow, pending: VerificationPendingBatch) {
    const page = await this.framePage(run, pending.video_id, pending.after_original_frame_id);
    const clipScores = run.scan_mode !== 'sparse'
      ? new Map<number, number>()
      : await this.clipScoresForFrames(
        run.run_id,
        pending.video_id,
        page.frames.map((frame) => frame.original_frame_id),
      );
    return {
      run: this.summary(run),
      video: parseVideoRank(run.video_rank).find((item) => item.video_id === pending.video_id) ?? null,
      batch: {
        ...page,
        frames: page.frames.map((frame) => {
          const clipScore = clipScores.get(frame.original_frame_id) ?? null;
          return {
            ...frame,
            clip_score: clipScore,
            prefilter_route: run.scan_mode !== 'sparse' ? 'vlm_review' as const : this.prefilterRoute(clipScore),
          };
        }),
      },
      requires_judgment_for: pending.frame_ids,
    };
  }

  private async clipScoresForFrames(runId: string, videoId: string, frameIds: readonly number[]) {
    if (frameIds.length === 0) return new Map<number, number>();
    const result = await this.database.query<{ original_frame_id: number; clip_score: number | string }>(`
      SELECT e.original_frame_id,
             MAX(1 - (ce.embedding <=> avr.query_embedding)) AS clip_score
      FROM agent_verification_runs avr
      JOIN evidence e ON e.video_id = $2 AND e.original_frame_id = ANY($3::integer[])
      JOIN clip_embeddings ce ON ce.evidence_id = e.evidence_id
      JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      JOIN index_release_features irf
        ON irf.feature_set_id = fs.feature_set_id
       AND irf.dataset_version = fs.dataset_version
       AND irf.modality = fs.modality
      JOIN index_releases ir
        ON ir.index_version = irf.index_version
       AND ir.dataset_version = irf.dataset_version
      WHERE avr.run_id = $1
        AND avr.query_embedding IS NOT NULL
        AND ir.status = 'active'
        AND ir.index_version = avr.index_version
        AND fs.modality = 'visual_embedding'
      GROUP BY e.original_frame_id`, [runId, videoId, frameIds]);
    return new Map(result.rows.map((row) => [Number(row.original_frame_id), Number(row.clip_score)]));
  }

  private prefilterRoute(score: number | null): 'auto_reject' | 'auto_accept' | 'vlm_review' {
    if (score === null || !Number.isFinite(score)) return 'vlm_review';
    if (score <= this.config.agentClipRejectBelow) return 'auto_reject';
    if (score >= this.config.agentClipAcceptAbove) return 'auto_accept';
    return 'vlm_review';
  }

  private async markVideoComplete(run: RunRow) {
    const videos = parseVideoRank(run.video_rank);
    const completed = run.current_video_index + 1 >= videos.length;
    await this.database.query(`
      UPDATE agent_verification_runs
      SET current_video_index = current_video_index + 1,
          current_frame_cursor = NULL,
            videos_examined = videos_examined + 1,
            status = CASE WHEN $2 THEN 'completed' ELSE 'running' END,
            completed_at = CASE WHEN $2 THEN now() ELSE NULL END,
            updated_at = now()
        WHERE run_id = $1 AND status = 'running'`, [run.run_id, completed]);
  }

  private assertDatabaseConfigured() {
    if (!this.database.isConfigured) {
      throw new ServiceUnavailableException(
        'Database is not configured; run migrations and set DATABASE_URL first',
      );
    }
  }

  private async embedQueryForPrefilter(query: string): Promise<readonly number[] | null> {
    if (!this.queryEmbedder.isConfigured) return null;
    try {
      return await this.queryEmbedder.embedText(query);
    } catch {
      return null;
    }
  }

  private assertLease(run: RunRow, workerId?: string) {
    if (!run.worker_id || !run.lease_expires_at) return;
    const leaseExpiresAt = new Date(run.lease_expires_at).getTime();
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()) return;
    if (workerId !== run.worker_id) {
      throw new ConflictException('verification run is leased by another worker');
    }
  }

  private async load(runId: string): Promise<RunRow> {
    const result = await this.database.query<RunRow>(
      'SELECT * FROM agent_verification_runs WHERE run_id = $1', [runId],
    );
    const run = result.rows[0];
    if (!run) throw new NotFoundException(`verification run ${runId} was not found`);
    return run;
  }

  private summary(run: RunRow) {
    const videos = parseVideoRank(run.video_rank);
    return {
      run_id: run.run_id,
      query_id: run.query_id,
      task: run.task,
      query: run.query_text,
      index_version: run.index_version,
      status: run.status,
      video_budget: run.video_budget,
      frame_batch_size: run.frame_batch_size,
      scan_mode: run.scan_mode,
      current_video_index: run.current_video_index,
      current_video_id: videos[run.current_video_index]?.video_id ?? null,
      videos_total: videos.length,
      videos_examined: run.videos_examined,
      frames_examined: run.frames_examined,
      frames_total: run.frames_total,
      coverage_ratio: run.frames_total > 0 ? run.frames_examined / run.frames_total : 1,
      pending_batch: Boolean(parsePendingBatch(run.pending_batch)),
      worker_id: run.worker_id,
      lease_expires_at: run.lease_expires_at,
      heartbeat_at: run.heartbeat_at,
      created_at: run.created_at,
      updated_at: run.updated_at,
      completed_at: run.completed_at,
    };
  }

  private async resultResponse(run: RunRow) {
    const [countResult, matchResult] = await Promise.all([
      this.database.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM agent_verification_judgments WHERE run_id = $1',
        [run.run_id],
      ),
      this.database.query<StoredJudgment>(`
        SELECT video_id, original_frame_id, relevant, score, reason, judged_at
        FROM agent_verification_judgments
        WHERE run_id = $1 AND relevant
        ORDER BY score DESC, judged_at, video_id, original_frame_id
        LIMIT 100`, [run.run_id]),
    ]);
    const legacyJudgments = parseJudgments(run.judgments);
    const normalizedCount = Number(countResult.rows[0]?.count ?? 0);
    const matches = matchResult.rows.map((judgment) => ({
      ...judgment,
      original_frame_id: Number(judgment.original_frame_id),
      score: Number(judgment.score),
    }));
    return {
      run: this.summary(run),
      judgment_count: Math.max(normalizedCount, legacyJudgments.length),
      matches,
      matches_truncated: matches.length === 100,
    };
  }
}
