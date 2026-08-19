import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_QUERY_IMPROVER_SETTINGS,
  loadQueryImproverSettings,
  saveQueryImproverSettings,
} from '@/lib/query-improver-settings';

afterEach(() => localStorage.clear());

describe('query improver settings', () => {
  it('loads the disabled default and persists the toggle', () => {
    expect(loadQueryImproverSettings()).toEqual(DEFAULT_QUERY_IMPROVER_SETTINGS);

    saveQueryImproverSettings({ enabled: true });

    expect(loadQueryImproverSettings()).toEqual({ enabled: true });
  });
});
