import { BadRequestException } from '@nestjs/common';

import { TASK_TYPES, type TaskType } from '../common/types';

type Answer = Readonly<Record<string, unknown>>;
export interface SubmissionInput {
  readonly query_id: string;
  readonly task: TaskType;
  readonly answers: readonly Answer[];
}

function text(value: unknown, field: string, maximum = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new BadRequestException(`${field} must contain 1-${maximum} characters`);
  }
  return value.trim();
}

function frame(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function exactKeys(answer: Answer, expected: readonly string[]): void {
  const actual = Object.keys(answer).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new BadRequestException(`answer fields must be exactly: ${expected.join(', ')}`);
  }
}

function validateAnswer(task: TaskType, answer: Answer, index: number): Record<string, unknown> {
  const prefix = `answers[${index}]`;
  if (task === 'textual_kis') {
    exactKeys(answer, ['video_id', 'frame_id']);
    return { video_id: text(answer.video_id, `${prefix}.video_id`, 200), frame_id: frame(answer.frame_id, `${prefix}.frame_id`) };
  }
  if (task === 'vqa') {
    exactKeys(answer, ['video_id', 'frame_id', 'answer']);
    return {
      video_id: text(answer.video_id, `${prefix}.video_id`, 200),
      frame_id: frame(answer.frame_id, `${prefix}.frame_id`),
      answer: text(answer.answer, `${prefix}.answer`, 100),
    };
  }
  exactKeys(answer, ['video_id', 'frame_ids']);
  if (!Array.isArray(answer.frame_ids) || answer.frame_ids.length === 0 || answer.frame_ids.length > 20) {
    throw new BadRequestException(`${prefix}.frame_ids must contain 1-20 frames`);
  }
  const frameIds = answer.frame_ids.map((value, frameIndex) => frame(value, `${prefix}.frame_ids[${frameIndex}]`));
  if (frameIds.some((value, frameIndex) => frameIndex > 0 && value <= frameIds[frameIndex - 1])) {
    throw new BadRequestException(`${prefix}.frame_ids must be strictly increasing`);
  }
  return { video_id: text(answer.video_id, `${prefix}.video_id`, 200), frame_ids: frameIds };
}

function csvCell(value: unknown): string {
  const rawValue = String(value);
  const stringValue = /^[=+\-@]/.test(rawValue) ? `'${rawValue}` : rawValue;
  // Quote whitespace-bearing text too, so free-form answers remain one field
  // in spreadsheet and CSV readers with less capable parsing.
  return /[",\r\n\s]/.test(stringValue)
    ? `"${stringValue.replaceAll('"', '""')}"`
    : stringValue;
}

function csv(task: TaskType, answers: readonly Record<string, unknown>[]): string {
  if (task === 'textual_kis') {
    return `${answers.map((answer) => `${csvCell(answer.video_id)},${csvCell(answer.frame_id)}`).join('\r\n')}\r\n`;
  }
  if (task === 'vqa') {
    return `${answers.map((answer) => `${csvCell(answer.video_id)},${csvCell(answer.frame_id)},${csvCell(answer.answer)}`).join('\r\n')}\r\n`;
  }
  return `${answers.map((answer) => [answer.video_id, ...(answer.frame_ids as number[])].map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function parseSubmissionInput(value: unknown): SubmissionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequestException('request body must be an object');
  const input = value as Record<string, unknown>;
  const task = input.task;
  if (typeof task !== 'string' || !TASK_TYPES.includes(task as TaskType)) throw new BadRequestException('invalid task');
  if (!Array.isArray(input.answers) || input.answers.length === 0 || input.answers.length > 100) {
    throw new BadRequestException('answers must contain at most 100 items and cannot be empty');
  }
  if (input.answers.some((answer) => typeof answer !== 'object' || answer === null || Array.isArray(answer))) {
    throw new BadRequestException('each answer must be an object');
  }
  return { query_id: text(input.query_id, 'query_id', 200), task: task as TaskType, answers: input.answers as Answer[] };
}

export function buildSubmissionPreview(value: unknown) {
  const input = parseSubmissionInput(value);
  const answers = input.answers.map((answer, index) => validateAnswer(input.task, answer, index));
  return {
    query_id: input.query_id,
    task: input.task,
    answer_count: answers.length,
    answers,
    csv: csv(input.task, answers),
    submittable: false,
    warnings: ['preview_only: organizer submission adapter is disabled'],
  };
}
