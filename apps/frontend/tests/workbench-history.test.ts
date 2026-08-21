import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_WORKBENCH_HISTORY_ENTRIES,
  clearWorkbenchHistory,
  createWorkbenchHistoryEntry,
  getOrCreateWorkbenchSessionId,
  loadWorkbenchHistory,
  removeWorkbenchHistoryEntry,
  saveWorkbenchHistoryEntry,
  type WorkbenchSnapshot,
} from '@/lib/workbench-history';

const snapshot: WorkbenchSnapshot = {
  task: 'textual_kis',
  description: 'A shop on a street',
  question: '',
  events: [{ event_id: 'event-1', event_ordinal: 1, description: '' }],
  response: null,
  rankedFrames: [],
  selectedAnchor: null,
  assignedFrames: [null],
  answers: [],
  qaAnswer: '',
  vqaQueue: [],
};

describe('workbench history persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates and reuses one browser session id', () => {
    const first = getOrCreateWorkbenchSessionId();
    const second = getOrCreateWorkbenchSessionId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('stores newest successful query first and restores its snapshot', () => {
    const older = createWorkbenchHistoryEntry(snapshot, new Date('2026-08-19T08:00:00.000Z'), 'history-old');
    const newer = createWorkbenchHistoryEntry(
      { ...snapshot, description: 'A red car near a building' },
      new Date('2026-08-19T09:00:00.000Z'),
      'history-new',
    );

    saveWorkbenchHistoryEntry(older);
    saveWorkbenchHistoryEntry(newer);

    expect(loadWorkbenchHistory().map((item) => item.history_id)).toEqual(['history-new', 'history-old']);
    expect(loadWorkbenchHistory()[0].description).toBe('A red car near a building');
  });

  it('keeps only the 50 newest entries and supports deletion', () => {
    for (let index = 0; index < MAX_WORKBENCH_HISTORY_ENTRIES + 3; index += 1) {
      saveWorkbenchHistoryEntry(createWorkbenchHistoryEntry(snapshot, new Date(index), `history-${index}`));
    }

    const entries = loadWorkbenchHistory();
    expect(entries).toHaveLength(MAX_WORKBENCH_HISTORY_ENTRIES);
    expect(entries[0].history_id).toBe('history-52');
    expect(entries.at(-1)?.history_id).toBe('history-3');

    removeWorkbenchHistoryEntry('history-52');
    expect(loadWorkbenchHistory().some((item) => item.history_id === 'history-52')).toBe(false);

    clearWorkbenchHistory();
    expect(loadWorkbenchHistory()).toEqual([]);
  });

  it('ignores malformed browser data instead of breaking the workbench', () => {
    localStorage.setItem('aic.workbench.history.v1', '{broken json');

    expect(loadWorkbenchHistory()).toEqual([]);
  });
});
