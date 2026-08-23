import * as z from 'zod/v4';

import { TASK_TYPES } from './types.js';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const taskSchema = z.enum(TASK_TYPES);

export const frameRefSchema = z.object({
  videoId: z.string().trim().regex(SAFE_IDENTIFIER, 'videoId has an invalid format'),
  originalFrameId: z.number().int().nonnegative().optional(),
  keyframeNo: z.number().int().positive().optional(),
}).strict().refine(
  (value) => (value.originalFrameId === undefined) !== (value.keyframeNo === undefined),
  { message: 'exactly one of originalFrameId or keyframeNo is required' },
);

export const videoIdSchema = z.string().trim().regex(SAFE_IDENTIFIER, 'videoId has an invalid format');

export function parseToolLimit(value: number | undefined, maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('tool maximum must be a positive integer');
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('limit must be a positive integer');
  return Math.min(value, maximum);
}

export function safeBackendUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('AIC_BACKEND_URL must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AIC_BACKEND_URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('AIC_BACKEND_URL must not contain credentials');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function safeEmbeddingUrl(value: string): string {
  if (value.trim().length < 1 || value.trim().length > 2000) {
    throw new Error('embedding service URL must contain 1-2000 characters');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('embedding service URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
    || url.username || url.password || url.search || url.hash) {
    throw new Error('embedding service URL must be HTTP or HTTPS without credentials or query parameters');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function toFrameQuery(ref: { readonly videoId: string; readonly originalFrameId?: number; readonly keyframeNo?: number }): {
  readonly video_id: string;
  readonly original_frame_id: number;
} {
  if (ref.originalFrameId !== undefined) {
    return { video_id: ref.videoId, original_frame_id: ref.originalFrameId };
  }
  throw new Error('frame query requires originalFrameId; resolve keyframe references first');
}
