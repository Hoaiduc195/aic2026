import { BadRequestException, Controller, Get, Inject, Param, Query } from '@nestjs/common';

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
}
