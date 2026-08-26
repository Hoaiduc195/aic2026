import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';

import { parseSearchRequest } from '../common/request-validation';
import type { VerificationJudgment } from './agent-verification.types';
import { AgentVerificationService } from './agent-verification.service';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

function runId(value: string): string {
  if (!SAFE_RUN_ID.test(value)) throw new BadRequestException('run_id is invalid');
  return value;
}

function workerId(value: string | undefined, required = false): string | undefined {
  const normalized = value?.trim();
  if (!normalized && !required) return undefined;
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(normalized)) {
    throw new BadRequestException('x-agent-worker-id is invalid');
  }
  return normalized;
}

function integer(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BadRequestException(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function parseStart(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('request body must be an object');
  }
  const body = value as Record<string, unknown>;
  const search = parseSearchRequest(body);
  return {
    search,
    options: {
      topK: integer(body.top_k, 'top_k', 1, 100, 20),
      videoBudget: integer(body.video_budget, 'video_budget', 1, 50, 10),
      frameBatchSize: integer(body.frame_batch_size, 'frame_batch_size', 1, 32, 8),
    },
  };
}

function parseJudgments(value: unknown): VerificationJudgment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('request body must be an object');
  }
  const raw = (value as Record<string, unknown>).judgments;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) {
    throw new BadRequestException('judgments must contain 1-32 items');
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadRequestException(`judgments[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.video_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(candidate.video_id)) {
      throw new BadRequestException(`judgments[${index}].video_id is invalid`);
    }
    if (!Number.isSafeInteger(candidate.original_frame_id) || (candidate.original_frame_id as number) < 0) {
      throw new BadRequestException(`judgments[${index}].original_frame_id is invalid`);
    }
    if (typeof candidate.relevant !== 'boolean') {
      throw new BadRequestException(`judgments[${index}].relevant must be boolean`);
    }
    const score = candidate.score === undefined ? (candidate.relevant ? 1 : 0) : candidate.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new BadRequestException(`judgments[${index}].score must be between 0 and 1`);
    }
    if (candidate.reason !== undefined && (typeof candidate.reason !== 'string' || candidate.reason.length > 200)) {
      throw new BadRequestException(`judgments[${index}].reason must be at most 200 characters`);
    }
    return {
      video_id: candidate.video_id,
      original_frame_id: candidate.original_frame_id as number,
      relevant: candidate.relevant,
      score,
      ...(typeof candidate.reason === 'string' && candidate.reason.trim() ? { reason: candidate.reason.trim() } : {}),
    };
  });
}

@Controller('v1/agent/frame-search')
export class AgentVerificationController {
  constructor(@Inject(AgentVerificationService) private readonly service: AgentVerificationService) {}

  @Post()
  start(@Body() body: unknown) {
    const parsed = parseStart(body);
    return this.service.start(parsed.search, parsed.options);
  }

  @Get(':runId')
  get(@Param('runId') value: string) {
    return this.service.get(runId(value));
  }

  @Get(':runId/batch')
  nextBatch(@Param('runId') value: string, @Headers('x-agent-worker-id') owner?: string) {
    return this.service.nextBatch(runId(value), workerId(owner));
  }

  @Post(':runId/judgments')
  submit(
    @Param('runId') value: string,
    @Body() body: unknown,
    @Headers('x-agent-worker-id') owner?: string,
  ) {
    return this.service.submit(runId(value), parseJudgments(body), workerId(owner));
  }

  @Post(':runId/claim')
  claim(
    @Param('runId') value: string,
    @Headers('x-agent-worker-id') owner?: string,
    @Body() body?: unknown,
  ) {
    const leaseMs = body && typeof body === 'object' && !Array.isArray(body)
      ? integer((body as Record<string, unknown>).lease_ms, 'lease_ms', 10_000, 300_000, 60_000)
      : 60_000;
    return this.service.claim(runId(value), workerId(owner, true)!, leaseMs);
  }

  @Post(':runId/heartbeat')
  heartbeat(
    @Param('runId') value: string,
    @Headers('x-agent-worker-id') owner?: string,
    @Body() body?: unknown,
  ) {
    const leaseMs = body && typeof body === 'object' && !Array.isArray(body)
      ? integer((body as Record<string, unknown>).lease_ms, 'lease_ms', 10_000, 300_000, 60_000)
      : 60_000;
    return this.service.heartbeat(runId(value), workerId(owner, true)!, leaseMs);
  }

  @Post(':runId/release')
  release(@Param('runId') value: string, @Headers('x-agent-worker-id') owner?: string) {
    return this.service.release(runId(value), workerId(owner, true)!);
  }

  @Post(':runId/stop')
  stop(@Param('runId') value: string) {
    return this.service.stop(runId(value));
  }
}
