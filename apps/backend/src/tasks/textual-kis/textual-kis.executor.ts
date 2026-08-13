import { Injectable } from '@nestjs/common';

import type { TaskExecutor, TaskExecutorInput } from '../task-executor';
import { buildSearchResponse } from '../task-executor';

@Injectable()
export class TextualKisExecutor implements TaskExecutor {
  readonly task = 'textual_kis' as const;
  readonly name = 'textual-kis-retrieval-v1';

  async execute(input: TaskExecutorInput) {
    return buildSearchResponse(input, this.name, []);
  }
}
