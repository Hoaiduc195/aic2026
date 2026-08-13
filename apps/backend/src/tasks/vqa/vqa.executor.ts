import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../common/tokens';
import type { BackendConfig } from '../../common/config';
import type { TaskExecutor, TaskExecutorInput } from '../task-executor';
import { buildSearchResponse } from '../task-executor';

@Injectable()
export class VqaExecutor implements TaskExecutor {
  readonly task = 'vqa' as const;
  readonly name = 'vqa-retrieval-manual-ready-v1';

  constructor(@Inject(APP_CONFIG) private readonly config: BackendConfig) {}

  async execute(input: TaskExecutorInput) {
    return buildSearchResponse(
      input,
      this.name,
      ['answer_reasoner_not_configured: candidate frames are ready for manual curation'],
    );
  }
}
