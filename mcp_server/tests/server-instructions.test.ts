import { describe, expect, it } from 'vitest';

import { SERVER_INSTRUCTIONS } from '../src/server.js';

describe('MCP server instructions', () => {
  it('defines the evidence trust hierarchy and visual verification policy', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/ASR[\s\S]*direct evidence[\s\S]*spoken|spoken[\s\S]*ASR[\s\S]*direct evidence/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/caption|OCR|object[\s\S]*(?:hint|reference|tham khảo)/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/visual claims|visual details|thuộc tính hình ảnh/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/get_frame_image|get_frame_context_batch/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/mâu thuẫn|conflict|uncertain/iu);
  });

  it('uses a bounded query reformulation ladder', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/primary retrieval query/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/maximum three query forms|at most three query forms|tối đa 3 dạng query/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/targeted reformulation|reformulate.*only when|chỉ.*reformulate/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not repeat|không lặp lại/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/search_loop/iu);
  });

  it('requires every explicit query requirement to be verified before returning a result', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/only return.*result.*when.*every explicit requirement.*verified/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/check.*each requirement independently|independently verify all requirements/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not return.*partial|do not return.*closest|không trả.*gần đúng/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/any requirement.*missing|ambiguous.*requirement|contradict.*requirement/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/uncertain|insufficient/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not export.*unless.*(?:all|every).*requirement/iu);
  });

  it('routes expensive tools only when their evidence value is needed', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/get_candidates[\s\S]*(?:only when|chỉ khi)/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/get_nearby_frames[\s\S]*(?:only when|chỉ khi)/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/stop|dừng[\s\S]*(?:evidence|đủ)/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/same tool|cùng tool|duplicate/iu);
  });

  it('exports CSV only when the user expresses submission intent', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/only.*(?:submission intent|intent to submit|yêu cầu.*CSV|ý định nộp)/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not.*(?:preview_submission|export|CSV).*(?:exploratory|thăm dò|without submission)/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/preview_submission/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/submission\/<query-id>\.csv/u);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/MANDATORY AUTOMATIC/iu);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/For every successful VQA query, automatically produce/iu);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/For every successful TRAKE query, automatically produce/iu);
  });

  it('uses an explicit query filename only when the user provides one', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/explicitly provides or requests an organizer query filename/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/otherwise[\s\S]*submission\/<query-id>\.csv/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not derive (?:it|the name) from backend `query_id`/iu);
  });

  it('keeps VQA and TRAKE task constraints explicit', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/VQA/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/answer.*(?:non-empty|không rỗng)/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/choose task `trake` only when[\s\S]*1-20[\s\S]*separate events[\s\S]*numbered/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not infer, split, or invent events/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/same video[\s\S]*strictly increasing/iu);
  });

  it('requires concise Vietnamese output and safe final CSV handling', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Vietnamese|tiếng Việt/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/concise|ngắn gọn/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/current working directory|working directory/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/successful validated preview|preview hợp lệ/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/preview_only/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/preview_only[\s\S]*does not invalidate a local save/iu);
  });
});
