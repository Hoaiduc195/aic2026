import { NotFoundException } from '@nestjs/common';
import type { QueryResultRow } from 'pg';

import type { DatabaseClient } from '../database/database.client';

export interface VideoRecord {
  readonly video_id: string;
  readonly object_key: string;
  readonly duration_ms: number;
  readonly fps: number;
  readonly mime_type: 'video/mp4' | 'video/webm' | 'video/ogg';
  readonly frame_count?: number | null;
}

export interface FrameRecord {
  readonly video_id: string;
  readonly keyframe_no: number;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly thumbnail_object_key: string;
}

export interface StudioCaptionRecord {
  readonly evidence_id: string;
  readonly text: string;
  readonly language: string;
  readonly producer: string;
}

export interface StudioOcrRecord {
  readonly evidence_id: string;
  readonly text: string;
  readonly language: string;
  readonly producer: string;
}

export interface StudioObjectRecord {
  readonly evidence_id: string;
  readonly label: string;
  readonly confidence: number;
  readonly normalized_bbox: readonly [number, number, number, number] | null;
  readonly producer: string;
}

export interface StudioFrameRecord {
  readonly video_id: string;
  readonly keyframe_no: number;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly captions: readonly StudioCaptionRecord[];
  readonly ocr: readonly StudioOcrRecord[];
  readonly objects: readonly StudioObjectRecord[];
}

export interface StudioAsrSpanRecord {
  readonly evidence_id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly language: string;
  readonly producer: string;
}

export interface VideoStudioRecord {
  readonly video: VideoRecord;
  readonly frames: readonly StudioFrameRecord[];
  readonly asr_spans: readonly StudioAsrSpanRecord[];
}

export interface MediaRepository {
  findVideo(videoId: string): Promise<VideoRecord>;
  findFrame(videoId: string, originalFrameId: number): Promise<FrameRecord | null>;
  findFrameByKeyframe(videoId: string, keyframeNo: number): Promise<FrameRecord | null>;
  findFramesPage(videoId: string, afterOriginalFrameId: number, limit: number): Promise<FrameRecord[]>;
  findFramesAround(videoId: string, centerFrameId: number, limit: number): Promise<FrameRecord[]>;
  findNearestStudioFrame(videoId: string, centerFrameId: number): Promise<StudioFrameRecord | null>;
  findAsrSpansAt(videoId: string, timestampMs: number): Promise<readonly StudioAsrSpanRecord[]>;
  findStudio(videoId: string): Promise<VideoStudioRecord>;
}

interface VideoRow extends QueryResultRow, VideoRecord {}
interface FrameRow extends QueryResultRow, FrameRecord {}
interface StudioFrameRow extends QueryResultRow {
  readonly video_id: string;
  readonly keyframe_no: number;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
}
interface StudioAnnotationRow extends QueryResultRow {
  readonly evidence_id: string;
  readonly evidence_type: 'caption' | 'object' | 'ocr';
  readonly original_frame_id: number;
  readonly text_content: string | null;
  readonly language: string | null;
  readonly producer: string;
  readonly label: string | null;
  readonly confidence: number | string | null;
  readonly normalized_bbox: number[] | null;
}
interface StudioAsrRow extends QueryResultRow {
  readonly evidence_id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text_content: string;
  readonly language: string;
  readonly producer: string;
}

export class PostgresMediaRepository implements MediaRepository {
  constructor(private readonly database: DatabaseClient) {}

  async findVideo(videoId: string): Promise<VideoRecord> {
    const result = await this.database.query<VideoRow>(
      'SELECT video_id, object_key, duration_ms, fps, mime_type, frame_count FROM videos WHERE video_id = $1',
      [videoId],
    );
    const video = result.rows[0];
    if (!video) throw new NotFoundException(`video ${videoId} was not found`);
    return video;
  }

  async findFrame(videoId: string, originalFrameId: number): Promise<FrameRecord | null> {
    const result = await this.database.query<FrameRow>(`
      SELECT video_id, keyframe_no, original_frame_id, timestamp_ms, thumbnail_object_key
      FROM frames
      WHERE video_id = $1 AND original_frame_id = $2`, [videoId, originalFrameId]);
    return result.rows[0] ?? null;
  }

  async findFrameByKeyframe(videoId: string, keyframeNo: number): Promise<FrameRecord | null> {
    const result = await this.database.query<FrameRow>(`
      SELECT video_id, keyframe_no, original_frame_id, timestamp_ms, thumbnail_object_key
      FROM frames
      WHERE video_id = $1 AND keyframe_no = $2`, [videoId, keyframeNo]);
    return result.rows[0] ?? null;
  }

  async findFramesPage(videoId: string, afterOriginalFrameId: number, limit: number): Promise<FrameRecord[]> {
    const result = await this.database.query<FrameRow>(`
      SELECT video_id, keyframe_no, original_frame_id, timestamp_ms, thumbnail_object_key
      FROM frames
      WHERE video_id = $1 AND original_frame_id > $2
      ORDER BY original_frame_id
      LIMIT $3`, [videoId, afterOriginalFrameId, limit]);
    return result.rows;
  }

  async findFramesAround(videoId: string, centerFrameId: number, limit: number): Promise<FrameRecord[]> {
    const result = await this.database.query<FrameRow>(`
      SELECT video_id, keyframe_no, original_frame_id, timestamp_ms, thumbnail_object_key
      FROM frames
      WHERE video_id = $1
      ORDER BY ABS(original_frame_id - $2), original_frame_id
      LIMIT $3`, [videoId, centerFrameId, limit]);
    return [...result.rows].sort((left, right) => left.original_frame_id - right.original_frame_id);
  }

  async findNearestStudioFrame(videoId: string, centerFrameId: number): Promise<StudioFrameRecord | null> {
    const frameResult = await this.database.query<StudioFrameRow>(`
      SELECT video_id, keyframe_no, original_frame_id, timestamp_ms
      FROM frames
      WHERE video_id = $1
      ORDER BY ABS(original_frame_id - $2), original_frame_id
      LIMIT 1`, [videoId, centerFrameId]);
    const frame = frameResult.rows[0];
    if (!frame) return null;

    const annotationResult = await this.database.query<StudioAnnotationRow>(`
      WITH active_feature_sets AS (
        SELECT DISTINCT fs.feature_set_id, fs.dataset_version, fs.modality
        FROM feature_sets fs
        JOIN index_release_features irf
          ON irf.feature_set_id = fs.feature_set_id
         AND irf.dataset_version = fs.dataset_version
         AND irf.modality = fs.modality
        JOIN index_releases ir
          ON ir.index_version = irf.index_version
         AND ir.dataset_version = irf.dataset_version
        WHERE ir.status = 'active'
      )
      SELECT e.evidence_id, e.evidence_type, e.original_frame_id,
             t.text_content, t.language, fs.producer,
             o.label, o.confidence, o.normalized_bbox
      FROM evidence e
      JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      JOIN active_feature_sets afs
        ON afs.feature_set_id = e.feature_set_id
       AND afs.dataset_version = fs.dataset_version
       AND afs.modality = fs.modality
      LEFT JOIN text_evidence t ON t.evidence_id = e.evidence_id
      LEFT JOIN object_evidence o ON o.evidence_id = e.evidence_id
      WHERE e.video_id = $1
        AND e.original_frame_id = $2
        AND e.evidence_type IN ('caption', 'object', 'ocr')
        AND (e.evidence_type <> 'caption' OR t.language = 'en')
      ORDER BY e.evidence_type, e.evidence_id`, [videoId, frame.original_frame_id]);

    let captions: StudioCaptionRecord[] = [];
    let ocr: StudioOcrRecord[] = [];
    let objects: StudioObjectRecord[] = [];
    for (const row of annotationResult.rows) {
      if (row.evidence_type === 'caption' && row.text_content?.trim()) {
        captions = [...captions, {
          evidence_id: row.evidence_id,
          text: row.text_content,
          language: row.language ?? 'unknown',
          producer: row.producer,
        }];
      }
      if (row.evidence_type === 'ocr' && row.text_content?.trim()) {
        ocr = [...ocr, {
          evidence_id: row.evidence_id,
          text: row.text_content,
          language: row.language ?? 'unknown',
          producer: row.producer,
        }];
      }
      if (row.evidence_type === 'object' && row.label?.trim()) {
        objects = [...objects, {
          evidence_id: row.evidence_id,
          label: row.label,
          confidence: Number(row.confidence ?? 0),
          normalized_bbox: normalizedBoundingBox(row.normalized_bbox),
          producer: row.producer,
        }];
      }
    }
    return {
      video_id: frame.video_id,
      keyframe_no: Number(frame.keyframe_no),
      original_frame_id: Number(frame.original_frame_id),
      timestamp_ms: Number(frame.timestamp_ms),
      captions,
      ocr,
      objects,
    };
  }

  async findStudio(videoId: string): Promise<VideoStudioRecord> {
    const video = await this.findVideo(videoId);
    const [frameResult, annotationResult, asrResult] = await Promise.all([
      this.database.query<StudioFrameRow>(`
        SELECT video_id, keyframe_no, original_frame_id, timestamp_ms
        FROM frames
        WHERE video_id = $1
        ORDER BY timestamp_ms, original_frame_id`, [videoId]),
      this.database.query<StudioAnnotationRow>(`
        WITH active_feature_sets AS (
          SELECT DISTINCT fs.feature_set_id, fs.dataset_version, fs.modality
          FROM feature_sets fs
          JOIN index_release_features irf
            ON irf.feature_set_id = fs.feature_set_id
           AND irf.dataset_version = fs.dataset_version
           AND irf.modality = fs.modality
          JOIN index_releases ir
            ON ir.index_version = irf.index_version
           AND ir.dataset_version = irf.dataset_version
          WHERE ir.status = 'active'
        )
        SELECT e.evidence_id, e.evidence_type, e.original_frame_id,
               t.text_content, t.language, fs.producer,
               o.label, o.confidence, o.normalized_bbox
        FROM evidence e
        JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
        JOIN active_feature_sets afs
          ON afs.feature_set_id = e.feature_set_id
         AND afs.dataset_version = fs.dataset_version
         AND afs.modality = fs.modality
        LEFT JOIN text_evidence t ON t.evidence_id = e.evidence_id
        LEFT JOIN object_evidence o ON o.evidence_id = e.evidence_id
        WHERE e.video_id = $1
          AND e.original_frame_id IS NOT NULL
          AND e.evidence_type IN ('caption', 'object', 'ocr')
          AND (e.evidence_type <> 'caption' OR t.language = 'en')
        ORDER BY e.original_frame_id, e.evidence_type, e.evidence_id`, [videoId]),
      this.database.query<StudioAsrRow>(`
        WITH active_feature_sets AS (
          SELECT DISTINCT fs.feature_set_id, fs.dataset_version, fs.modality
          FROM feature_sets fs
          JOIN index_release_features irf
            ON irf.feature_set_id = fs.feature_set_id
           AND irf.dataset_version = fs.dataset_version
           AND irf.modality = fs.modality
          JOIN index_releases ir
            ON ir.index_version = irf.index_version
           AND ir.dataset_version = irf.dataset_version
          WHERE ir.status = 'active'
        )
        SELECT e.evidence_id, e.start_ms, e.end_ms,
               t.text_content, t.language, fs.producer
        FROM evidence e
        JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
        JOIN active_feature_sets afs
          ON afs.feature_set_id = e.feature_set_id
         AND afs.dataset_version = fs.dataset_version
         AND afs.modality = fs.modality
        JOIN text_evidence t ON t.evidence_id = e.evidence_id
        WHERE e.video_id = $1
          AND e.evidence_type = 'asr'
        ORDER BY e.start_ms, e.end_ms, e.evidence_id`, [videoId]),
    ]);

    const frames: StudioFrameRecord[] = frameResult.rows.map((row) => ({
      video_id: row.video_id,
      keyframe_no: Number(row.keyframe_no),
      original_frame_id: Number(row.original_frame_id),
      timestamp_ms: Number(row.timestamp_ms),
      captions: [],
      ocr: [],
      objects: [],
    }));
    const framesById = new Map(frames.map((frame) => [frame.original_frame_id, frame]));

    for (const row of annotationResult.rows) {
      const frame = framesById.get(Number(row.original_frame_id));
      if (!frame) continue;
      if (row.evidence_type === 'caption' && row.text_content?.trim()) {
        const caption: StudioCaptionRecord = {
          evidence_id: row.evidence_id,
          text: row.text_content,
          language: row.language ?? 'unknown',
          producer: row.producer,
        };
        framesById.set(frame.original_frame_id, {
          ...frame,
          captions: [...frame.captions, caption],
        });
      }
      if (row.evidence_type === 'ocr' && row.text_content?.trim()) {
        const text: StudioOcrRecord = {
          evidence_id: row.evidence_id,
          text: row.text_content,
          language: row.language ?? 'unknown',
          producer: row.producer,
        };
        framesById.set(frame.original_frame_id, {
          ...frame,
          ocr: [...frame.ocr, text],
        });
      }
      if (row.evidence_type === 'object' && row.label?.trim()) {
        const object: StudioObjectRecord = {
          evidence_id: row.evidence_id,
          label: row.label,
          confidence: Number(row.confidence ?? 0),
          normalized_bbox: normalizedBoundingBox(row.normalized_bbox),
          producer: row.producer,
        };
        framesById.set(frame.original_frame_id, {
          ...frame,
          objects: [...frame.objects, object],
        });
      }
    }

    return {
      video,
      frames: frames.map((frame) => framesById.get(frame.original_frame_id) ?? frame),
      asr_spans: asrResult.rows.map((row) => ({
        evidence_id: row.evidence_id,
        start_ms: Number(row.start_ms),
        end_ms: Number(row.end_ms),
        text: row.text_content,
        language: row.language,
        producer: row.producer,
      })),
    };
  }

  async findAsrSpansAt(videoId: string, timestampMs: number): Promise<readonly StudioAsrSpanRecord[]> {
    const result = await this.database.query<StudioAsrRow>(`
      WITH active_feature_sets AS (
        SELECT DISTINCT fs.feature_set_id, fs.dataset_version, fs.modality
        FROM feature_sets fs
        JOIN index_release_features irf
          ON irf.feature_set_id = fs.feature_set_id
         AND irf.dataset_version = fs.dataset_version
         AND irf.modality = fs.modality
        JOIN index_releases ir
          ON ir.index_version = irf.index_version
         AND ir.dataset_version = irf.dataset_version
        WHERE ir.status = 'active'
      )
      SELECT e.evidence_id, e.start_ms, e.end_ms, t.text_content, t.language, fs.producer
      FROM evidence e
      JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      JOIN active_feature_sets afs
        ON afs.feature_set_id = e.feature_set_id
       AND afs.dataset_version = fs.dataset_version
       AND afs.modality = fs.modality
      JOIN text_evidence t ON t.evidence_id = e.evidence_id
      WHERE e.video_id = $1
        AND e.evidence_type = 'asr'
        AND e.start_ms <= $2
        AND e.end_ms > $2
      ORDER BY e.start_ms, e.end_ms, e.evidence_id`, [videoId, timestampMs]);
    return result.rows.map((row) => ({
      evidence_id: row.evidence_id,
      start_ms: Number(row.start_ms),
      end_ms: Number(row.end_ms),
      text: row.text_content,
      language: row.language,
      producer: row.producer,
    }));
  }
}

export class UnavailableMediaRepository implements MediaRepository {
  async findVideo(_videoId: string): Promise<VideoRecord> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findFrame(_videoId: string, _originalFrameId: number): Promise<FrameRecord | null> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findFrameByKeyframe(_videoId: string, _keyframeNo: number): Promise<FrameRecord | null> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findFramesPage(_videoId: string, _afterOriginalFrameId: number, _limit: number): Promise<FrameRecord[]> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findFramesAround(_videoId: string, _centerFrameId: number, _limit: number): Promise<FrameRecord[]> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findNearestStudioFrame(_videoId: string, _centerFrameId: number): Promise<StudioFrameRecord | null> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findAsrSpansAt(_videoId: string, _timestampMs: number): Promise<readonly StudioAsrSpanRecord[]> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findStudio(_videoId: string): Promise<VideoStudioRecord> {
    throw new NotFoundException('media catalog is not configured');
  }
}

function normalizedBoundingBox(value: number[] | null): [number, number, number, number] | null {
  if (!value || value.length !== 4 || value.some((item) => !Number.isFinite(item))) return null;
  return [value[0], value[1], value[2], value[3]];
}
