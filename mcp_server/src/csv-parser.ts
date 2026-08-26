import type { TaskType } from './types.js';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const MAX_CSV_BYTES = 1_000_000;
const MAX_ROWS = 100;
const MAX_TRAKE_FRAMES = 20;

export type ParsedSubmissionRow =
  | { readonly rowNumber: number; readonly videoId: string; readonly frameId: number }
  | { readonly rowNumber: number; readonly videoId: string; readonly frameId: number; readonly answer: string }
  | { readonly rowNumber: number; readonly videoId: string; readonly frameIds: readonly number[] };

export interface ParsedSubmissionCsv {
  readonly task: TaskType;
  readonly rowCount: number;
  readonly rows: readonly ParsedSubmissionRow[];
  readonly warnings: readonly string[];
}

export interface ParseSubmissionCsvOptions {
  readonly hasHeader?: boolean;
}

export function parseSubmissionCsv(task: TaskType, csv: string, options: ParseSubmissionCsvOptions = {}): ParsedSubmissionCsv {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) throw new Error('CSV exceeds the 1 MB limit');
  const records = parseRecords(csv);
  const data = options.hasHeader ? records.slice(1) : records;
  if (data.length === 0) throw new Error('CSV does not contain answer rows');
  if (data.length > MAX_ROWS) throw new Error('CSV contains more than 100 answer rows');
  const rows = data.map((record, index) => parseRow(task, record, options.hasHeader ? index + 2 : index + 1));
  return { task, rowCount: rows.length, rows, warnings: [] };
}

function parseRecords(csv: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let hasContent = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (inQuotes) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      hasContent = true;
      continue;
    }
    if (character === '"') {
      if (field.length > 0) throw new Error('CSV contains an unexpected quote');
      inQuotes = true;
      hasContent = true;
    } else if (character === ',') {
      fields.push(field);
      field = '';
      hasContent = true;
    } else if (character === '\r' || character === '\n') {
      fields.push(field);
      field = '';
      if (hasContent || fields.some((value) => value.length > 0)) rows.push(fields);
      fields = [];
      hasContent = false;
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
    } else {
      field += character;
      hasContent = true;
    }
  }
  if (inQuotes) throw new Error('CSV contains an unterminated quoted field');
  if (hasContent || field.length > 0 || fields.length > 0) {
    fields.push(field);
    rows.push(fields);
  }
  return rows;
}

function parseRow(task: TaskType, fields: readonly string[], rowNumber: number): ParsedSubmissionRow {
  if (task === 'textual_kis') {
    if (fields.length !== 2) throw new Error(`row ${rowNumber} must contain videoId and frameId`);
    return { rowNumber, videoId: videoId(fields[0], rowNumber), frameId: frameId(fields[1], rowNumber) };
  }
  if (task === 'vqa') {
    if (fields.length !== 3) throw new Error(`row ${rowNumber} must contain videoId, frameId and answer`);
    const answer = fields[2].trim();
    if (!answer || answer.length > 100) throw new Error(`row ${rowNumber} answer is invalid`);
    return { rowNumber, videoId: videoId(fields[0], rowNumber), frameId: frameId(fields[1], rowNumber), answer };
  }
  if (fields.length < 2 || fields.length > MAX_TRAKE_FRAMES + 1) throw new Error(`row ${rowNumber} must contain 1-${MAX_TRAKE_FRAMES} frame IDs`);
  const frameIds = fields.slice(1).map((value) => frameId(value, rowNumber));
  if (frameIds.some((value, index) => index > 0 && value <= frameIds[index - 1])) throw new Error(`row ${rowNumber} frame IDs must be strictly increasing`);
  return { rowNumber, videoId: videoId(fields[0], rowNumber), frameIds };
}

function videoId(value: string | undefined, rowNumber: number): string {
  const normalized = value?.trim() ?? '';
  if (!SAFE_IDENTIFIER.test(normalized)) throw new Error(`row ${rowNumber} videoId is invalid`);
  return normalized;
}

function frameId(value: string | undefined, rowNumber: number): number {
  const normalized = value?.trim() ?? '';
  if (!/^\d+$/u.test(normalized)) throw new Error(`row ${rowNumber} frameId is invalid`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) throw new Error(`row ${rowNumber} frameId is invalid`);
  return parsed;
}
