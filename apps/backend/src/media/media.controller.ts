import { BadRequestException, Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { MediaService } from './media.service';

function identifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new BadRequestException(`${field} has an invalid format`);
  }
  return value;
}

function integer(value: string | undefined, field: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestException(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

@Controller('v1/videos')
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Get(':videoId/playback')
  playback(@Param('videoId') videoId: string) {
    return this.media.getPlayback(identifier(videoId, 'video_id'));
  }

  @Get(':videoId/studio')
  studio(@Param('videoId') videoId: string) {
    return this.media.getStudio(identifier(videoId, 'video_id'));
  }

  @Get(':videoId/frames')
  frames(
    @Param('videoId') videoId: string,
    @Query('center_frame_id') centerFrameId: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.media.getFrames(
      identifier(videoId, 'video_id'),
      integer(centerFrameId, 'center_frame_id', 0, 2_147_483_647),
      integer(limit, 'limit', 1, 100, 25),
    );
  }

  @Get(':videoId/frames/:frameId')
  frame(
    @Param('videoId') videoId: string,
    @Param('frameId') frameId: string,
  ) {
    return this.media.getFrame(
      identifier(videoId, 'video_id'),
      integer(frameId, 'frame_id', 0, 2_147_483_647),
    );
  }

  @Get(':videoId/keyframes/:keyframeNo')
  keyframe(
    @Param('videoId') videoId: string,
    @Param('keyframeNo') keyframeNo: string,
  ) {
    return this.media.getFrameByKeyframe(
      identifier(videoId, 'video_id'),
      integer(keyframeNo, 'keyframe_no', 1, 2_147_483_647),
    );
  }

  @Get(':videoId/frames/:frameId/thumbnail')
  async frameThumbnail(
    @Param('videoId') videoId: string,
    @Param('frameId') frameId: string,
    @Res() response: Response,
  ) {
    const result = await this.media.getFrameThumbnail(
      identifier(videoId, 'video_id'),
      integer(frameId, 'frame_id', 0, 2_147_483_647),
    );
    response.setHeader('content-type', result.mime_type);
    response.setHeader('cache-control', 'private, max-age=3600');
    response.send(result.bytes);
  }
}
