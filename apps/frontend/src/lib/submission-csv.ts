import type { QualificationAnswer, QualificationTask } from './contracts';

export const MAX_CSV_ROWS = 100;
export const MAX_QA_ANSWER_CHARACTERS = 2000;

export class CsvExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvExportError';
  }
}

/**
 * Builds the headerless CSV required by the qualification submission format.
 * The returned string is UTF-8 text without a BOM; callers may add a BOM when
 * downloading it for spreadsheet applications.
 */
export function buildSubmissionCsv(
  task: QualificationTask,
  answers: readonly QualificationAnswer[],
): string {
  if (answers.length === 0) {
    throw new CsvExportError('Không có đáp án để export CSV.');
  }
  if (answers.length > MAX_CSV_ROWS) {
    throw new CsvExportError(`CSV chỉ được phép có tối đa ${MAX_CSV_ROWS} dòng.`);
  }

  const rows = answers.map((answer) => {
    const videoId = csvCell(videoFilename(answer.video_id));

    if (task === 'textual_kis') {
      if (!('frame_id' in answer) || 'frame_ids' in answer) {
        throw new CsvExportError('Đáp án không đúng format Textual KIS.');
      }
      validateFrameId(answer.frame_id);
      return [videoId, csvCell(answer.frame_id)].join(',');
    }

    if (task === 'qa') {
      if (!('frame_id' in answer) || !('answer' in answer) || 'frame_ids' in answer) {
        throw new CsvExportError('Đáp án không đúng format Q&A.');
      }
      validateFrameId(answer.frame_id);
      const text = normalizeAnswer(answer.answer);
      if (!text) {
        throw new CsvExportError('Q&A phải có câu trả lời.');
      }
      if (Array.from(text).length > MAX_QA_ANSWER_CHARACTERS) {
        throw new CsvExportError(
          `Câu trả lời Q&A không được vượt quá ${MAX_QA_ANSWER_CHARACTERS} ký tự.`,
        );
      }
      return [videoId, csvCell(answer.frame_id), csvCell(text)].join(',');
    }

    if (!('frame_ids' in answer) || answer.frame_ids.length === 0) {
      throw new CsvExportError('Đáp án không đúng format TRAKE.');
    }
    answer.frame_ids.forEach(validateFrameId);
    if (answer.frame_ids.some((frameId, index) => index > 0 && frameId <= answer.frame_ids[index - 1])) {
      throw new CsvExportError('Các frame của TRAKE phải theo thứ tự thời gian tăng dần.');
    }
    return [videoId, ...answer.frame_ids.map(csvCell)].join(',');
  });

  return `${rows.join('\r\n')}\r\n`;
}

function normalizeAnswer(value: string): string {
  return value.trim();
}

function validateFrameId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CsvExportError('Frame ID phải là số nguyên không âm.');
  }
}

function videoFilename(value: string): string {
  return value.replace(/\.mp4$/i, '');
}

function csvCell(value: string | number): string {
  const rawText = String(value);
  const text = /^[=+\-@]/.test(rawText) ? `'${rawText}` : rawText;
  // Quote whitespace-bearing text as well as delimiter characters. The
  // competition accepts unquoted simple answers, but quoting these values
  // keeps the answer in one field for spreadsheet and CSV readers that
  // handle free-form text inconsistently.
  return /[",\r\n\s]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
