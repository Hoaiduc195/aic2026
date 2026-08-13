import 'server-only';

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { VideoFramesResponse, VideoPlayback } from './contracts';
import { isSafeVideoId, parseFrameMapCsv, selectFrameWindow } from './media-adapter';

const WINDOWS_MEDIA_ROOT = 'E:\\aic2026';

export interface VideoAsset {
  path: string;
  size: number;
}

export async function getPlayback(videoId: string): Promise<VideoPlayback> {
  validateVideoId(videoId);
  const [metadataText, mapText] = await Promise.all([
    readFile(mediaPath('media-info-aic25-b1', 'media-info', `${videoId}.json`), 'utf8'),
    readFile(mediaPath('map-keyframes-aic25-b1', 'map-keyframes', `${videoId}.csv`), 'utf8'),
  ]);
  const metadata = JSON.parse(metadataText) as { length?: unknown };
  const durationSeconds = typeof metadata.length === 'number' ? metadata.length : Number.NaN;
  const firstDataRow = mapText.trim().split(/\r?\n/)[1]?.split(',');
  const fps = Number(firstDataRow?.[2]);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error('metadata media không hợp lệ');
  }

  await getVideoAsset(videoId);
  return {
    video_id: videoId,
    playback_uri: `/api/v1/media/videos/${encodeURIComponent(videoId)}`,
    duration_ms: Math.round(durationSeconds * 1000),
    fps,
    mime_type: 'video/mp4',
  };
}

export async function getFrameContext(videoId: string, centerFrameId: number, limit: number): Promise<VideoFramesResponse> {
  validateVideoId(videoId);
  const csv = await readFile(mediaPath('map-keyframes-aic25-b1', 'map-keyframes', `${videoId}.csv`), 'utf8');
  const frames = selectFrameWindow(parseFrameMapCsv(csv, videoId), centerFrameId, limit);
  return { video_id: videoId, center_frame_id: centerFrameId, frames };
}

export async function getKeyframePath(videoId: string, originalFrameId: number): Promise<string> {
  const context = await getFrameContext(videoId, originalFrameId, 1);
  const frame = context.frames[0];
  if (!frame) throw new Error('không tìm thấy keyframe');
  const path = mediaPath('keyframes', videoId, `${String(frame.keyframe_no).padStart(3, '0')}.jpg`);
  await stat(path);
  return path;
}

export async function getVideoAsset(videoId: string): Promise<VideoAsset> {
  validateVideoId(videoId);
  const path = mediaPath('videos', `${videoId}.mp4`);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('video không tồn tại');
  return { path, size: metadata.size };
}

function validateVideoId(videoId: string): void {
  if (!isSafeVideoId(videoId)) throw new Error('video_id không hợp lệ');
}

function mediaPath(...segments: string[]): string {
  const configuredRoot = process.env.AIC_MEDIA_ROOT?.trim();
  const root = resolve(configuredRoot || (process.platform === 'win32' ? WINDOWS_MEDIA_ROOT : ''));
  if (!configuredRoot && process.platform !== 'win32') throw new Error('AIC_MEDIA_ROOT chưa được cấu hình');
  const target = resolve(root, ...segments);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('đường dẫn media không hợp lệ');
  }
  return target;
}
