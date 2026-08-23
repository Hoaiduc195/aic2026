import { describe, expect, it } from 'vitest';

import { parseSubmissionCsv } from '../src/csv-parser.js';

describe('parseSubmissionCsv', () => {
  it('parses multiple rows and preserves quoted commas and newlines in VQA answers', () => {
    const parsed = parseSubmissionCsv('vqa', 'video-1,10,"một người, đang chạy"\r\nvideo-2,11,"dòng một\ndòng hai"\r\n');

    expect(parsed.rows).toEqual([
      { rowNumber: 1, videoId: 'video-1', frameId: 10, answer: 'một người, đang chạy' },
      { rowNumber: 2, videoId: 'video-2', frameId: 11, answer: 'dòng một\ndòng hai' },
    ]);
  });

  it('supports a header and TRAKE rows with strictly increasing frame IDs', () => {
    const parsed = parseSubmissionCsv('trake', 'video_id,frame_id_1,frame_id_2,frame_id_3\r\nvideo-1,10,20,30\r\n', { hasHeader: true });

    expect(parsed.rows).toEqual([{ rowNumber: 2, videoId: 'video-1', frameIds: [10, 20, 30] }]);
  });

  it('rejects malformed CSV, invalid IDs and non-increasing TRAKE frames', () => {
    expect(() => parseSubmissionCsv('vqa', 'video-1,10,"unterminated')).toThrow('unterminated');
    expect(() => parseSubmissionCsv('textual_kis', 'video 1,10')).toThrow('videoId');
    expect(() => parseSubmissionCsv('trake', 'video-1,20,10')).toThrow('strictly increasing');
  });
});
