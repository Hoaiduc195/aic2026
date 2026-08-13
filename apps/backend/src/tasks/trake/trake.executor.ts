import { Injectable } from '@nestjs/common';

import type { TaskExecutor, TaskExecutorInput } from '../task-executor';
import { buildSearchResponse } from '../task-executor';

@Injectable()
export class TrakeExecutor implements TaskExecutor {
  readonly task = 'trake' as const;
  readonly name = 'trake-retrieval-temporal-ready-v1';

  async execute(input: TaskExecutorInput) {
    return buildSearchResponse(
      input,
      this.name,
      ['temporal_aligner_not_configured: returning ordered retrieval candidates'],
    );
  }
}
