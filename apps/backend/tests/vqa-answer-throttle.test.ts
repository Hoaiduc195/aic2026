import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { VqaAnswerController } from '../src/tasks/vqa/vqa-answer.controller';

describe('VQA answer throughput policy', () => {
  it('allows enough requests for a 100-frame batch in one minute', () => {
    const descriptor = Object.getOwnPropertyDescriptor(VqaAnswerController.prototype, 'answer');
    const method = descriptor?.value;

    expect(method).toBeDefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBeGreaterThanOrEqual(100);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(60_000);
  });
});
