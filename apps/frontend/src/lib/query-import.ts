import type { QualificationAnswer, QualificationTask } from './contracts';
import { MAX_CSV_ROWS, MAX_QA_ANSWER_CHARACTERS } from './submission-csv';

const SAFE_VIDEO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_TRAKE_FRAMES = 20;

export interface ImportedFrameRef {
  readonly video_id: string;
  readonly original_frame_id: number;
}

export interface CsvImportIssue {
  readonly row: number;
  readonly message: string;
}

export interface AnswerCsvImportResult {
  readonly answers: readonly QualificationAnswer[];
  readonly frame_refs: readonly ImportedFrameRef[];
  readonly issues: readonly CsvImportIssue[];
}

interface CsvRow {
  readonly row: number;
  readonly cells: readonly string[];
  readonly error?: string;
}

export function parseAnswerCsv(value: string, task: QualificationTask): AnswerCsvImportResult {
  const rows = parseCsvRows(value.replace(/^\uFEFF/, ''));
  const answers: QualificationAnswer[] = [];
  const frameRefs: ImportedFrameRef[] = [];
  const issues: CsvImportIssue[] = [];

  if (rows.length > MAX_CSV_ROWS) {
    issues.push({ row: MAX_CSV_ROWS + 1, message: `CSV chỉ được phép có tối đa ${MAX_CSV_ROWS} dòng.` });
  }

  for (const row of rows.slice(0, MAX_CSV_ROWS)) {
    if (row.error) {
      issues.push({ row: row.row, message: row.error });
      continue;
    }
    if (row.cells.every((cell) => !cell.trim())) continue;

    try {
      const parsed = parseAnswerRow(row.cells, task);
      answers.push(parsed.answer);
      frameRefs.push(...parsed.frame_refs);
    } catch (error) {
      issues.push({ row: row.row, message: error instanceof Error ? error.message : 'Dòng CSV không hợp lệ.' });
    }
  }

  return { answers, frame_refs: frameRefs, issues };
}

function parseAnswerRow(cells: readonly string[], task: QualificationTask): {
  readonly answer: QualificationAnswer;
  readonly frame_refs: readonly ImportedFrameRef[];
} {
  const videoId = cells[0]?.trim() ?? '';
  if (!SAFE_VIDEO_ID.test(videoId)) throw new Error('video_id không hợp lệ.');

  if (task === 'textual_kis') {
    if (cells.length !== 2) throw new Error('Textual KIS cần đúng 2 cột.');
    const frameId = parseFrameId(cells[1]);
    return {
      answer: { video_id: videoId, frame_id: frameId },
      frame_refs: [{ video_id: videoId, original_frame_id: frameId }],
    };
  }

  if (task === 'qa') {
    if (cells.length !== 3) throw new Error('Q&A cần đúng 3 cột.');
    const frameId = parseFrameId(cells[1]);
    const answer = cells[2].trim();
    if (!answer) throw new Error('Q&A phải có câu trả lời.');
    if (Array.from(answer).length > MAX_QA_ANSWER_CHARACTERS) {
      throw new Error(`Câu trả lời Q&A không được vượt quá ${MAX_QA_ANSWER_CHARACTERS} ký tự.`);
    }
    return {
      answer: { video_id: videoId, frame_id: frameId, answer },
      frame_refs: [{ video_id: videoId, original_frame_id: frameId }],
    };
  }

  if (cells.length < 2 || cells.length > MAX_TRAKE_FRAMES + 1) {
    throw new Error(`TRAKE cần từ 1 đến ${MAX_TRAKE_FRAMES} frame.`);
  }
  const frameIds = cells.slice(1).map(parseFrameId);
  if (frameIds.some((frameId, index) => index > 0 && frameId <= frameIds[index - 1])) {
    throw new Error('Các frame của TRAKE phải theo thứ tự thời gian tăng dần.');
  }
  return {
    answer: { video_id: videoId, frame_ids: frameIds },
    frame_refs: frameIds.map((originalFrameId) => ({ video_id: videoId, original_frame_id: originalFrameId })),
  };
}

function parseFrameId(value: string | undefined): number {
  const normalized = value?.trim() ?? '';
  if (!/^\d+$/.test(normalized)) throw new Error('frame_id phải là số nguyên không âm.');
  const frameId = Number(normalized);
  if (!Number.isSafeInteger(frameId) || frameId < 0) throw new Error('frame_id phải là số nguyên không âm.');
  return frameId;
}

function parseCsvRows(value: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let rowNumber = 1;
  let rowStart = 1;

  const pushRow = (error?: string) => {
    rows.push({ row: rowStart, cells: [...cells, cell], ...(error ? { error } : {}) });
    cells = [];
    cell = '';
    rowStart = rowNumber;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      if (character === '\n') rowNumber += 1;
      continue;
    }

    if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ',') {
      cells.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && value[index + 1] === '\n') index += 1;
      rowNumber += 1;
      pushRow();
    } else {
      cell += character;
    }
  }

  if (quoted) {
    rows.push({ row: rowStart, cells: [...cells, cell], error: 'CSV có dấu ngoặc kép chưa đóng.' });
  } else if (cell || cells.length > 0 || value.length === 0) {
    rows.push({ row: rowStart, cells: [...cells, cell] });
  }
  return rows;
}
