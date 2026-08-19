import { describe, expect, it, vi } from 'vitest';

import type { LanguageModel } from '../src/compute/model-ports';
import { QueryImproverService } from '../src/query-improver/query-improver.service';

function model(output: string): LanguageModel {
  return {
    isConfigured: true,
    modelName: 'test-query-improver',
    complete: vi.fn(async () => output),
  };
}

describe('QueryImproverService', () => {
  it('rewrites a Vietnamese query into one precise English retrieval query', async () => {
    const languageModel = model(JSON.stringify({
      improved_query: 'A person wearing a red shirt enters a room.',
    }));
    const service = new QueryImproverService(languageModel);

    const result = await service.improve({
      query: 'một người mặc áo đỏ đi vào phòng',
      task: 'textual_kis',
    });

    expect(result.improved_query).toBe('A person wearing a red shirt enters a room.');
    expect(result.changed).toBe(true);
    expect(languageModel.complete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('một người mặc áo đỏ đi vào phòng'),
    }));
  });

  it('keeps TRAKE event count and ordering in one model call', async () => {
    const languageModel = model(JSON.stringify({
      improved_query: '1. A person opens a door\n2. The person enters the room',
    }));
    const service = new QueryImproverService(languageModel);

    const result = await service.improve({
      query: '1. một người mở cửa\n2. người đó bước vào phòng',
      task: 'trake',
    });

    expect(result.improved_query).toBe('1. A person opens a door\n2. The person enters the room');
    expect(languageModel.complete).toHaveBeenCalledTimes(1);
  });

  it('improves the event query and question separately for VQA', async () => {
    const languageModel = model(JSON.stringify({
      improved_query: 'A shop on a street.',
      improved_question: 'What is the woman holding?',
    }));
    const service = new QueryImproverService(languageModel);

    const result = await service.improve({
      query: 'Một cửa hàng trên phố',
      question: 'Người phụ nữ đang cầm gì?',
      task: 'vqa',
    });

    expect(result).toMatchObject({
      improved_query: 'A shop on a street.',
      improved_question: 'What is the woman holding?',
      original_question: 'Người phụ nữ đang cầm gì?',
      changed: true,
    });
    expect(languageModel.complete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Original Vietnamese question'),
    }));
  });

  it('falls back to the original query when the model is unavailable', async () => {
    const languageModel: LanguageModel = {
      isConfigured: false,
      modelName: 'unconfigured',
      complete: vi.fn(),
    };
    const service = new QueryImproverService(languageModel);

    const result = await service.improve({ query: 'một người đi bộ', task: 'textual_kis' });

    expect(result).toMatchObject({
      improved_query: 'một người đi bộ',
      changed: false,
      warning: 'query_improver_unavailable',
    });
    expect(languageModel.complete).not.toHaveBeenCalled();
  });

  it('falls back when the model returns malformed or structurally unsafe output', async () => {
    const languageModel = model(JSON.stringify({ improved_query: '1. only one event' }));
    const service = new QueryImproverService(languageModel);

    const result = await service.improve({
      query: '1. mở cửa\n2. bước vào phòng',
      task: 'trake',
    });

    expect(result.improved_query).toBe('1. mở cửa\n2. bước vào phòng');
    expect(result.changed).toBe(false);
    expect(result.warning).toBe('query_improver_invalid_output');
  });
});
