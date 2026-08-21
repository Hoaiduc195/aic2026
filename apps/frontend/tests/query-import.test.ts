import { describe, expect, it } from 'vitest';

import { parseAnswerCsv } from '@/lib/query-import';

describe('answer CSV import', () => {
  it('parses Textual KIS rows and exposes exact frame references', () => {
    const result = parseAnswerCsv('\uFEFFvideo_01,385\r\nvideo_02.mp4,17\r\n', 'textual_kis');

    expect(result.answers).toEqual([
      { video_id: 'video_01', frame_id: 385 },
      { video_id: 'video_02.mp4', frame_id: 17 },
    ]);
    expect(result.frame_refs).toEqual([
      { video_id: 'video_01', original_frame_id: 385 },
      { video_id: 'video_02.mp4', original_frame_id: 17 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('keeps valid rows while reporting malformed rows', () => {
    const result = parseAnswerCsv('video_01,385\nvideo_02,-1\nvideo_03,not-a-frame,extra\n', 'textual_kis');

    expect(result.answers).toEqual([{ video_id: 'video_01', frame_id: 385 }]);
    expect(result.issues).toEqual([
      { row: 2, message: 'frame_id phải là số nguyên không âm.' },
      { row: 3, message: 'Textual KIS cần đúng 2 cột.' },
    ]);
  });

  it('parses Q&A answers and TRAKE sequences', () => {
    expect(parseAnswerCsv('video_01,385,"Người phụ nữ rẽ phải"\n', 'qa')).toMatchObject({
      answers: [{ video_id: 'video_01', frame_id: 385, answer: 'Người phụ nữ rẽ phải' }],
      frame_refs: [{ video_id: 'video_01', original_frame_id: 385 }],
    });
    expect(parseAnswerCsv('video_01,10,20,30,40\n', 'trake')).toMatchObject({
      answers: [{ video_id: 'video_01', frame_ids: [10, 20, 30, 40] }],
      frame_refs: [
        { video_id: 'video_01', original_frame_id: 10 },
        { video_id: 'video_01', original_frame_id: 20 },
        { video_id: 'video_01', original_frame_id: 30 },
        { video_id: 'video_01', original_frame_id: 40 },
      ],
    });
  });
});
