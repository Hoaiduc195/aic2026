import { describe, expect, it } from 'vitest';

import { SERVER_INSTRUCTIONS } from '../src/server.js';

describe('MCP server instructions', () => {
  it('requires automatic 100-row CSV preparation with a configurable focus segment', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/MANDATORY AUTOMATIC TOP-100 CSV WORKFLOW/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not wait for the user to ask for CSV/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/explicit focus count/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/first N rows/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/prepare_top100_focus_csv/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/submission\/<query-id>\.csv/u);
  });

  it('requires automatic CSV export for VQA and TRAKE queries', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/VQA[^\n]*automatically[^\n]*CSV/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/TRAKE[^\n]*automatically[^\n]*CSV/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/suggest_vqa_answer/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/check_trake_sequence/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/preview_submission/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/submission\/<query-id>\.csv/u);
  });

  it('requires concise Vietnamese output and local saving in the current working directory', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Vietnamese|tiếng Việt/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/concise|ngắn gọn/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/current working directory|working directory/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/always save|luôn lưu/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/preview_only/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/submittable[^\n]*not invalid|không đồng nghĩa[^\n]*không hợp lệ/iu);
  });
});
