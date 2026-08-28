import { BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';

import { FRAME_DECODER, IMAGE_COMPRESSOR, MEDIA_REPOSITORY, OBJECT_STORAGE } from '../common/tokens';
import type { ObjectStorage } from '../storage/object-storage';
import type { FrameDecoder } from './frame-decoder';
import type { ImageCompressor } from './image-compressor';
import type { MediaRepository, StudioAsrSpanRecord, StudioFrameRecord } from './media.repository';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const COMPRESSED_IMAGE_TARGET_BYTES = 8 * 1024 * 1024;
type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ExactFrameResponse extends Omit<StudioFrameRecord, 'keyframe_no'> {
  readonly keyframe_no: number | null;
  readonly thumbnail_uri: string | null;
  readonly is_exact_frame: true;
  readonly annotation_source_frame_id: number | null;
  readonly asr_spans: readonly StudioAsrSpanRecord[];
}

export interface FrameThumbnail {
  readonly mime_type: ImageMimeType;
  readonly bytes: Buffer;
}

function imageMimeType(value: string | null, fallback: ImageMimeType): ImageMimeType {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized === 'image/jpeg' || normalized === 'image/png'
    || normalized === 'image/webp' || normalized === 'image/gif'
    ? normalized
    : fallback;
}

function imageMimeTypeFromKey(objectKey: string): ImageMimeType {
  const extension = objectKey.toLowerCase().split('?')[0]?.split('.').pop();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return 'image/jpeg';
}

async function readImageBody(response: Response): Promise<Buffer> {
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error('frame thumbnail exceeds the output limit');
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('frame thumbnail exceeds the output limit');
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('frame thumbnail exceeds the output limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadImage(url: string, fallbackMimeType: ImageMimeType): Promise<FrameThumbnail> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`frame thumbnail returned HTTP ${response.status}`);
  const bytes = await readImageBody(response);
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('frame thumbnail has an invalid size');
  return { mime_type: imageMimeType(response.headers.get('content-type'), fallbackMimeType), bytes };
}

@Injectable()
export class MediaService {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Optional() @Inject(FRAME_DECODER) private readonly decoder?: FrameDecoder,
    @Optional() @Inject(IMAGE_COMPRESSOR) private readonly compressor?: ImageCompressor,
  ) {}

  async getPlayback(videoId: string) {
    if (!this.storage.isConfigured) throw new ServiceUnavailableException('R2 object storage is not configured');
    const video = await this.repository.findVideo(videoId);
    return {
      video_id: video.video_id,
      playback_uri: await this.storage.signReadUrl(video.object_key),
      duration_ms: Number(video.duration_ms),
      fps: Number(video.fps),
      ...(video.frame_count === null || video.frame_count === undefined ? {} : { frame_count: Number(video.frame_count) }),
      mime_type: video.mime_type,
    };
  }

  async getStudio(videoId: string) {
    if (!this.storage.isConfigured) throw new ServiceUnavailableException('R2 object storage is not configured');
    const studio = await this.repository.findStudio(videoId);
    return {
      video: {
        video_id: studio.video.video_id,
        playback_uri: await this.storage.signReadUrl(studio.video.object_key),
        duration_ms: Number(studio.video.duration_ms),
        fps: Number(studio.video.fps),
        ...(studio.video.frame_count === null || studio.video.frame_count === undefined
          ? {}
          : { frame_count: Number(studio.video.frame_count) }),
        mime_type: studio.video.mime_type,
      },
      frames: studio.frames,
      asr_spans: studio.asr_spans,
    };
  }

  async getFrames(videoId: string, centerFrameId: number, limit: number, frameStep = 1) {
    if (!this.storage.isConfigured) throw new ServiceUnavailableException('R2 object storage is not configured');
    const frames = await this.repository.findFramesAround(videoId, centerFrameId, limit, frameStep);
    return {
      video_id: videoId,
      center_frame_id: centerFrameId,
      frames: await Promise.all(frames.map(async (frame) => ({
        video_id: frame.video_id,
        keyframe_no: Number(frame.keyframe_no),
        original_frame_id: Number(frame.original_frame_id),
        timestamp_ms: Number(frame.timestamp_ms),
        thumbnail_uri: await this.storage.signReadUrl(frame.thumbnail_object_key),
      }))),
    };
  }

  async getFrame(videoId: string, originalFrameId: number): Promise<ExactFrameResponse> {
    if (!this.storage.isConfigured) throw new ServiceUnavailableException('R2 object storage is not configured');
    const video = await this.repository.findVideo(videoId);
    if (video.frame_count !== null && video.frame_count !== undefined && originalFrameId >= video.frame_count) {
      throw new BadRequestException('frame_id is outside the video frame range');
    }
    const exact = await this.repository.findFrame(videoId, originalFrameId);
    const timestampMs = exact?.timestamp_ms ?? Math.round((originalFrameId / video.fps) * 1000);
    const [annotation, asrSpans] = await Promise.all([
      this.repository.findNearestStudioFrame(videoId, originalFrameId),
      this.repository.findAsrSpansAt(videoId, timestampMs),
    ]);
    const thumbnailUri = exact ? await this.storage.signReadUrl(exact.thumbnail_object_key) : null;
    return {
      video_id: videoId,
      keyframe_no: exact?.keyframe_no ?? null,
      original_frame_id: originalFrameId,
      timestamp_ms: timestampMs,
      captions: annotation?.captions ?? [],
      ocr: annotation?.ocr ?? [],
      objects: annotation?.objects ?? [],
      asr_spans: asrSpans,
      thumbnail_uri: thumbnailUri,
      is_exact_frame: true,
      annotation_source_frame_id: annotation?.original_frame_id ?? null,
    };
  }

  async getFrameByKeyframe(videoId: string, keyframeNo: number): Promise<ExactFrameResponse> {
    const frame = await this.repository.findFrameByKeyframe(videoId, keyframeNo);
    if (!frame) throw new NotFoundException(`keyframe ${keyframeNo} was not found`);
    const exact = await this.getFrame(videoId, frame.original_frame_id);
    return { ...exact, keyframe_no: frame.keyframe_no };
  }

  async getFrameThumbnail(videoId: string, originalFrameId: number): Promise<FrameThumbnail> {
    if (!this.storage.isConfigured) throw new ServiceUnavailableException('R2 object storage is not configured');
    const video = await this.repository.findVideo(videoId);
    if (video.frame_count !== null && video.frame_count !== undefined && originalFrameId >= video.frame_count) {
      throw new BadRequestException('frame_id is outside the video frame range');
    }
    const exact = await this.repository.findFrame(videoId, originalFrameId);
    if (exact) {
      const thumbnailUrl = await this.storage.signReadUrl(exact.thumbnail_object_key);
      try {
        return await downloadImage(thumbnailUrl, imageMimeTypeFromKey(exact.thumbnail_object_key));
      } catch {
        if (this.compressor) {
          try {
            const compressed = await this.compressor.compress({
              image_url: thumbnailUrl,
              target_bytes: COMPRESSED_IMAGE_TARGET_BYTES,
            });
            if (compressed.bytes.length > 0 && compressed.bytes.length <= MAX_IMAGE_BYTES) {
              return compressed;
            }
          } catch {
            // A stale sparse thumbnail should not prevent an exact source-frame decode.
          }
        }
      }
    }
    if (!this.decoder) throw new ServiceUnavailableException('exact frame decoder is not configured');
    const videoUrl = await this.storage.signReadUrl(video.object_key);
    try {
      const decoded = await this.decoder.decode({
        video_url: videoUrl,
        original_frame_id: originalFrameId,
        fps: video.fps,
        max_bytes: MAX_IMAGE_BYTES,
      });
      if (decoded.bytes.length === 0 || decoded.bytes.length > MAX_IMAGE_BYTES) {
        throw new Error('decoded frame has an invalid size');
      }
      return decoded;
    } catch {
      throw new ServiceUnavailableException('exact frame thumbnail could not be generated');
    }
  }
}
