import { describe, expect, it } from 'vitest';

import { buildSubmissionCsv, CsvExportError } from '../src/lib/submission-csv';

describe('buildSubmissionCsv', () => {
  it('exports textual KIS rows without a header and removes the mp4 suffix', () => {
    expect(buildSubmissionCsv('textual_kis', [
      { video_id: 'video-01.mp4', frame_id: 12 },
      { video_id: 'video-02', frame_id: 34 },
    ])).toBe('video-01,12\r\nvideo-02,34\r\n');
  });

  it('exports Q&A answers in Vietnamese and escapes CSV content', () => {
    expect(buildSubmissionCsv('qa', [
      { video_id: 'video-01.mp4', frame_id: 12, answer: 'Có, "đúng"\nnhư vậy' },
    ])).toBe('video-01,12,"Có, ""đúng""\nnhư vậy"\r\n');
  });

  it('quotes answers containing spaces so each answer remains one CSV field', () => {
    expect(buildSubmissionCsv('qa', [
      { video_id: 'video-01', frame_id: 12, answer: 'Màu đỏ' },
      { video_id: 'video-02', frame_id: 34, answer: 'Năm người' },
    ])).toBe('video-01,12,"Màu đỏ"\r\nvideo-02,34,"Năm người"\r\n');
  });

  it('neutralizes spreadsheet formulas in free-form answers', () => {
    expect(buildSubmissionCsv('qa', [
      { video_id: 'video-01', frame_id: 12, answer: '=HYPERLINK("bad")' },
    ])).toBe('video-01,12,"\'=HYPERLINK(""bad"")"\r\n');
  });

  it('exports TRAKE frame ids in the supplied temporal order', () => {
    expect(buildSubmissionCsv('trake', [
      { video_id: 'video-01.mp4', frame_ids: [12, 18, 25] },
    ])).toBe('video-01,12,18,25\r\n');
  });

  it('rejects a Q&A answer over the 2000-character limit', () => {
    expect(() => buildSubmissionCsv('qa', [
      { video_id: 'video-01', frame_id: 12, answer: 'a'.repeat(2001) },
    ])).toThrowError(CsvExportError);
  });

  it('rejects more than 100 rows instead of producing an invalid submission', () => {
    const answers = Array.from({ length: 101 }, (_, frame_id) => ({
      video_id: 'video-01',
      frame_id,
    }));

    expect(() => buildSubmissionCsv('textual_kis', answers)).toThrowError(CsvExportError);
  });

  it('rejects TRAKE rows whose frame ids are not in temporal order', () => {
    expect(() => buildSubmissionCsv('trake', [
      { video_id: 'video-01', frame_ids: [25, 12] },
    ])).toThrowError(CsvExportError);
  });
});
