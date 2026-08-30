import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { buildSubmissionPreview } from '../src/manual/submission-preview';

describe('submission preview', () => {
  it('builds canonical JSON and CSV for VQA without submitting externally', () => {
    const preview = buildSubmissionPreview({
      query_id: 'q-1',
      task: 'vqa',
      answers: [{ video_id: 'video-1', frame_id: 42, answer: 'màu đỏ' }],
    });

    expect(preview.submittable).toBe(false);
    expect(preview.answer_count).toBe(1);
    expect(preview.csv).toBe('video-1,42,màu đỏ\r\n');
  });

  it('quotes CSV values and preserves TRAKE frame order', () => {
    const preview = buildSubmissionPreview({
      query_id: 'q-2',
      task: 'trake',
      answers: [{ video_id: 'video,2', frame_ids: [10, 20, 30] }],
    });

    expect(preview.csv).toContain('"video,2",10,20,30');
  });

  it('removes an .mp4 suffix from exported video names', () => {
    const preview = buildSubmissionPreview({
      query_id: 'q-video', task: 'textual_kis',
      answers: [{ video_id: 'L01_V028.mp4', frame_id: 3450 }],
    });
    expect(preview.csv).toBe('L01_V028,3450\r\n');
  });

  it('preserves free-form VQA answers exactly', () => {
    const preview = buildSubmissionPreview({
      query_id: 'q-formula', task: 'vqa',
      answers: [{ video_id: 'video-1', frame_id: 1, answer: '=HYPERLINK("bad")' }],
    });
    expect(preview.csv).toContain('"=HYPERLINK(""bad"")"');
  });

  it('rejects task-mismatched or excessive answers', () => {
    expect(() => buildSubmissionPreview({
      query_id: 'q-3', task: 'textual_kis',
      answers: [{ video_id: 'video-1', frame_id: 1, answer: 'not allowed' }],
    })).toThrow(BadRequestException);

    expect(() => buildSubmissionPreview({
      query_id: 'q-4', task: 'vqa',
      answers: Array.from({ length: 101 }, (_, index) => ({ video_id: 'v', frame_id: index, answer: 'a' })),
    })).toThrow('at most 100');

    expect(() => buildSubmissionPreview({
      query_id: 'q-5', task: 'vqa',
      answers: [{ video_id: 'video-1', frame_id: 1, answer: 'a'.repeat(101) }],
    })).toThrow('100');
  });
});
