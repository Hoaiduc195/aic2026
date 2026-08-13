import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { MEDIA_REPOSITORY, OBJECT_STORAGE } from '../common/tokens';
import type { ObjectStorage } from '../storage/object-storage';
import type { MediaRepository } from './media.repository';

@Injectable()
export class MediaService {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async getPlayback(videoId: string) {
    if (!this.storage.isConfigured) throw new ServiceUnavailableException('R2 object storage is not configured');
    const video = await this.repository.findVideo(videoId);
    return {
      video_id: video.video_id,
      playback_uri: await this.storage.signReadUrl(video.object_key),
      duration_ms: Number(video.duration_ms),
      fps: Number(video.fps),
      mime_type: video.mime_type,
    };
  }

  async getFrames(videoId: string, centerFrameId: number, limit: number) {
    if (!this.storage.isConfigured) throw new ServiceUnavailableException('R2 object storage is not configured');
    const frames = await this.repository.findFramesAround(videoId, centerFrameId, limit);
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
}
