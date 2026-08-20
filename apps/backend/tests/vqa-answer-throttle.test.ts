import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';

import { VqaAnswerController } from '../src/tasks/vqa/vqa-answer.controller';

describe('VQA answer throughput policy', () => {
  it('allows enough requests for a 100-frame batch in one minute', () => {
    const descriptor = Object.getOwnPropertyDescriptor(VqaAnswerController.prototype, 'answer');
    const method = descriptor?.value;

    expect(method).toBeDefined();
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, method)).toBeGreaterThanOrEqual(100);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, method)).toBe(60_000);
  });
});
