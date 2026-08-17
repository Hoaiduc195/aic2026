import { BadRequestException, Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';

import { OBJECT_STORAGE, RETRIEVAL_STORE } from '../common/tokens';
import type { RetrievalStore } from '../retrieval/retrieval.store';
import { buildSubmissionPreview, parseSubmissionInput } from './submission-preview';
import type { ObjectStorage } from '../storage/object-storage';
import { signPreviewUris } from '../storage/preview-url';

function id(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) throw new BadRequestException('query_id has an invalid format');
  return value;
}

function pageInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new BadRequestException('invalid pagination');
  return parsed;
}

@Controller('v1/queries')
export class ManualController {
  constructor(
    @Inject(RETRIEVAL_STORE) private readonly store: RetrievalStore,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Get(':queryId/candidates')
  async candidates(@Param('queryId') queryId: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const page = await this.store.listCandidates(
      id(queryId),
      pageInteger(limit, 100, 1, 1000),
      pageInteger(offset, 0, 0, 1_000_000),
    );
    return { ...page, candidates: await signPreviewUris(page.candidates, this.storage) };
  }

  @Get(':queryId/selection')
  selection(@Param('queryId') queryId: string) {
    return this.store.getLatestSelection(id(queryId));
  }

  @Put(':queryId/selection')
  async replaceSelection(@Param('queryId') queryId: string, @Body() body: unknown) {
    const validId = id(queryId);
    const preview = buildSubmissionPreview({ ...(body as object), query_id: validId });
    const input = parseSubmissionInput(preview);
    const note = typeof (body as Record<string, unknown>)?.note === 'string'
      ? ((body as Record<string, unknown>).note as string).slice(0, 2000)
      : undefined;
    return this.store.saveSelection(validId, input.task, preview.answers, note);
  }
}
