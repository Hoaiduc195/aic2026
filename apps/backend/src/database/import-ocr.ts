import 'dotenv/config';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, resolve } from 'node:path';
import { Client } from 'pg';

const FEATURE_SET_ID = 'aic2026:ocr';
const DATASET_VERSION = 'aic2026';
const SOURCE_URI = 'file:///data/ocr/ocr.jsonl';
const BATCH_SIZE = 250;

interface FrameRow {
  readonly video_id: string;
  readonly keyframe_no: number;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly fps: number | null;
}

interface OcrText {
  readonly text: string;
  readonly confidence: number;
  readonly bbox?: unknown;
  readonly source?: string;
  readonly detection_confidence?: number;
}

interface OcrRecord {
  readonly frame_path: string;
  readonly frame_id?: number;
  readonly texts: readonly (OcrText & { readonly accepted?: boolean })[];
  readonly width?: number;
  readonly height?: number;
  readonly language?: string;
  readonly model_version?: string;
  readonly pipeline_version?: string;
}

interface ImportRow {
  readonly evidenceId: string;
  readonly frame: FrameRow;
  readonly sourceRecordIndex: number;
  readonly text: string;
  readonly normalizedText: string;
  readonly language: string;
  readonly confidence: number;
  readonly payload: string;
}

interface Counters {
  seen: number;
  inserted: number;
  updated: number;
  skipped: number;
  unmatched_frame: number;
  no_accepted_text: number;
}

function requiredConnectionString(): string {
  const value = process.env.DATABASE_DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL is required');
  return value;
}

function sourcePath(): string {
  return process.env.OCR_JSONL_PATH?.trim()
    || resolve(process.cwd(), '..', '..', '..', 'data', 'ocr', 'ocr.jsonl');
}

function applyRequested(): boolean {
  return process.env.OCR_IMPORT_APPLY === 'true';
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function frameKey(videoId: string, keyframeNo: number): string {
  return `${videoId}\u0000${keyframeNo}`;
}

function parseFramePath(value: string): { readonly videoId: string; readonly keyframeNo: number } | null {
  const videoId = basename(dirname(value));
  const match = basename(value).match(/^(\d+)\.jpg$/i);
  if (!/^[A-Za-z0-9_-]+$/.test(videoId) || !match) return null;
  const keyframeNo = Number(match[1]);
  return Number.isSafeInteger(keyframeNo) && keyframeNo > 0 ? { videoId, keyframeNo } : null;
}

function parseRecord(value: string, lineNumber: number): OcrRecord {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`line ${lineNumber} must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.frame_path !== 'string' || !Array.isArray(record.texts)) {
    throw new Error(`line ${lineNumber} is missing frame_path or texts`);
  }
  return record as unknown as OcrRecord;
}

function acceptedTexts(record: OcrRecord): readonly OcrText[] {
  return record.texts.filter((item): item is OcrText => (
    item?.accepted === true
    && typeof item.text === 'string'
    && normalizeText(item.text).length > 0
    && typeof item.confidence === 'number'
    && Number.isFinite(item.confidence)
    && item.confidence >= 0
    && item.confidence <= 1
  ));
}

function importRow(record: OcrRecord, frame: FrameRow, sourceRecordIndex: number): ImportRow | null {
  const texts = acceptedTexts(record);
  if (texts.length === 0) return null;
  const text = normalizeText(texts.map((item) => item.text).join(' '));
  if (!text) return null;
  const confidence = texts.reduce((sum, item) => sum + item.confidence, 0) / texts.length;
  return {
    evidenceId: `ocr:${frame.video_id}:${frame.keyframe_no}`,
    frame,
    sourceRecordIndex,
    text,
    normalizedText: text,
    language: typeof record.language === 'string' && record.language.trim() ? record.language.trim() : 'unknown',
    confidence,
    payload: JSON.stringify({
      source: 'ocr.jsonl',
      frame_path: record.frame_path,
      source_frame_id: record.frame_id ?? null,
      width: record.width ?? null,
      height: record.height ?? null,
      model_version: record.model_version ?? null,
      pipeline_version: record.pipeline_version ?? null,
      texts,
    }),
  };
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function frameMap(client: Client): Promise<Map<string, FrameRow>> {
  const result = await client.query<FrameRow>(`
    SELECT f.video_id, f.keyframe_no, f.original_frame_id, f.timestamp_ms, v.fps
    FROM frames f
    JOIN videos v ON v.video_id = f.video_id
  `);
  return new Map(result.rows.map((row) => [frameKey(row.video_id, row.keyframe_no), row]));
}

async function activeIndex(client: Client): Promise<{ readonly indexVersion: string; readonly datasetVersion: string }> {
  const result = await client.query<{ index_version: string; dataset_version: string }>(`
    SELECT index_version, dataset_version
    FROM index_releases
    WHERE status = 'active'
    ORDER BY index_version
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) throw new Error('no active index release is available for OCR');
  if (row.dataset_version !== DATASET_VERSION) {
    throw new Error(`active index dataset version ${row.dataset_version} does not match ${DATASET_VERSION}`);
  }
  return { indexVersion: row.index_version, datasetVersion: row.dataset_version };
}

async function startImport(client: Client, checksum: string): Promise<string> {
  const ingestionId = `ocr-import-${checksum.slice(0, 32)}`;
  await client.query(`
    INSERT INTO feature_sets (
      feature_set_id, modality, dataset_version, pipeline_version, schema_version,
      producer, model_name, model_version, manifest_uri, manifest_sha256
    ) VALUES ($1, 'ocr', $2, 'ocr-jsonl-import-v1', '1.0.0', 'paddleocr', 'PP-OCRv6', NULL, $3, $4)
    ON CONFLICT (feature_set_id) DO UPDATE SET
      pipeline_version = EXCLUDED.pipeline_version,
      manifest_uri = EXCLUDED.manifest_uri,
      manifest_sha256 = EXCLUDED.manifest_sha256
  `, [FEATURE_SET_ID, DATASET_VERSION, SOURCE_URI, checksum]);
  const result = await client.query<{ ingestion_id: string }>(`
    INSERT INTO ingestion_runs (
      ingestion_id, feature_set_id, source_artifact_uri, source_checksum_sha256,
      target_table, dataset_version, pipeline_version, status
    ) VALUES ($1, $2, $3, $4, 'evidence', $5, 'ocr-jsonl-import-v1', 'running')
    ON CONFLICT (source_artifact_uri, source_checksum_sha256, target_table) DO UPDATE SET
      status = 'running', finished_at = NULL, errors = '[]'::jsonb
    RETURNING ingestion_id
  `, [ingestionId, FEATURE_SET_ID, SOURCE_URI, checksum, DATASET_VERSION]);
  return result.rows[0].ingestion_id;
}

async function flushBatch(client: Client, batch: readonly ImportRow[]): Promise<{ readonly inserted: number; readonly updated: number }> {
  if (batch.length === 0) return { inserted: 0, updated: 0 };
  const parameters: unknown[] = [];
  const values = batch.map((row, index) => {
    const offset = index * 9;
    const frameDurationMs = Math.max(1, Math.round(1_000 / (row.frame.fps || 30)));
    parameters.push(
      row.evidenceId, row.frame.video_id, FEATURE_SET_ID, row.sourceRecordIndex,
      row.frame.original_frame_id, row.frame.timestamp_ms, row.frame.timestamp_ms + frameDurationMs,
      row.confidence, row.payload,
    );
    return `($${offset + 1}, 'ocr', $${offset + 2}, $${offset + 3}, NULL, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::jsonb)`;
  });
  const evidenceResult = await client.query<{ inserted: boolean }>(`
    INSERT INTO evidence (
      evidence_id, evidence_type, video_id, feature_set_id, artifact_id, source_record_index,
      original_frame_id, start_ms, end_ms, confidence, payload
    ) VALUES ${values.join(', ')}
    ON CONFLICT (evidence_id) DO UPDATE SET
      video_id = EXCLUDED.video_id,
      feature_set_id = EXCLUDED.feature_set_id,
      source_record_index = EXCLUDED.source_record_index,
      original_frame_id = EXCLUDED.original_frame_id,
      start_ms = EXCLUDED.start_ms,
      end_ms = EXCLUDED.end_ms,
      confidence = EXCLUDED.confidence,
      payload = EXCLUDED.payload
    RETURNING xmax = 0 AS inserted
  `, parameters);

  const textParameters: unknown[] = [];
  const textValues = batch.map((row, index) => {
    const offset = index * 4;
    textParameters.push(row.evidenceId, row.text, row.normalizedText, row.language);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
  });
  await client.query(`
    INSERT INTO text_evidence (evidence_id, text_content, normalized_text, language)
    VALUES ${textValues.join(', ')}
    ON CONFLICT (evidence_id) DO UPDATE SET
      text_content = EXCLUDED.text_content,
      normalized_text = EXCLUDED.normalized_text,
      language = EXCLUDED.language
  `, textParameters);

  const inserted = evidenceResult.rows.filter((row) => row.inserted).length;
  return { inserted, updated: batch.length - inserted };
}

async function completeImport(
  client: Client,
  ingestionId: string,
  checksum: string,
  counters: Counters,
): Promise<void> {
  const index = await activeIndex(client);
  await client.query('BEGIN');
  try {
    await client.query(`
      INSERT INTO index_release_features (index_version, dataset_version, modality, feature_set_id)
      VALUES ($1, $2, 'ocr', $3)
      ON CONFLICT (index_version, modality) DO UPDATE SET
        dataset_version = EXCLUDED.dataset_version,
        feature_set_id = EXCLUDED.feature_set_id
    `, [index.indexVersion, index.datasetVersion, FEATURE_SET_ID]);
    await client.query(`
      UPDATE ingestion_runs
      SET status = 'completed', records_seen = $2, records_inserted = $3, records_updated = $4,
          records_skipped = $5, records_failed = 0, checkpoint = $6::jsonb, finished_at = now()
      WHERE ingestion_id = $1
    `, [ingestionId, counters.seen, counters.inserted, counters.updated, counters.skipped,
      JSON.stringify({ checksum, feature_set_id: FEATURE_SET_ID })]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const path = sourcePath();
  const [file, checksum] = await Promise.all([stat(path), fileDigest(path)]);
  const client = new Client({ connectionString: requiredConnectionString(), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const frames = await frameMap(client);
    const counters: Counters = {
      seen: 0, inserted: 0, updated: 0, skipped: 0, unmatched_frame: 0, no_accepted_text: 0,
    };
    const batch: ImportRow[] = [];
    const ingestionId = applyRequested() ? await startImport(client, checksum) : null;
    const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });

    for await (const line of input) {
      counters.seen += 1;
      const record = parseRecord(line, counters.seen);
      const framePath = parseFramePath(record.frame_path);
      const frame = framePath ? frames.get(frameKey(framePath.videoId, framePath.keyframeNo)) : undefined;
      if (!frame) {
        counters.skipped += 1;
        counters.unmatched_frame += 1;
        continue;
      }
      if (acceptedTexts(record).length === 0) {
        counters.skipped += 1;
        counters.no_accepted_text += 1;
        continue;
      }
      const row = importRow(record, frame, counters.seen - 1);
      if (!row) throw new Error(`line ${counters.seen} could not create OCR evidence`);
      batch.push(row);
      if (batch.length < BATCH_SIZE) continue;
      if (applyRequested()) {
        const result = await flushBatch(client, batch);
        counters.inserted += result.inserted;
        counters.updated += result.updated;
      }
      batch.length = 0;
    }

    if (applyRequested() && batch.length > 0) {
      const result = await flushBatch(client, batch);
      counters.inserted += result.inserted;
      counters.updated += result.updated;
    }
    if (applyRequested()) await completeImport(client, ingestionId!, checksum, counters);
    process.stdout.write(`${applyRequested() ? 'Imported' : 'Validated'} OCR: ${JSON.stringify({
      path, size_bytes: file.size, checksum, ...counters, matched: counters.seen - counters.skipped,
    })}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`OCR import failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
