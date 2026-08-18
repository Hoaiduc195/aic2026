import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/database/database.client';
import { UnavailableLanguageModel, type LanguageModel } from '../src/compute/model-ports';
import type { VisionLanguageModel } from '../src/compute/vlm-vision.client';
import {
  parseVqaAnswerRequest,
  type VqaAnswerRequest,
} from '../src/tasks/vqa/vqa-answer.request';
import { VqaAnswerService } from '../src/tasks/vqa/vqa-answer.service';
import {
  PostgresVqaGroundingRepository,
  UnavailableVqaGroundingRepository,
  type VqaGroundingContext,
  type VqaGroundingRepository,
} from '../src/tasks/vqa/vqa-grounding.repository';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input: VqaAnswerRequest = {
  query_id: 'query-1', question: 'Người phụ nữ đang cầm vật gì?', video_id: 'video-1', original_frame_id: 42,
};

function context(evidence: VqaGroundingContext['evidence'] = [{
  evidence_id: 'caption-1', type: 'caption', start_ms: 4200, end_ms: 4300,
  snippet: 'A woman is holding a bottle.', producer: 'caption:v1',
}]): VqaGroundingContext {
  return {
    query_id: 'query-1', task: 'vqa', video_id: 'video-1', original_frame_id: 42,
    timestamp_ms: 4200, thumbnail_object_key: 'keyframes/video-1/42.jpg', evidence,
  };
}

function model(output: string): LanguageModel {
  return {
    isConfigured: true,
    modelName: 'aic-qa-v1',
    complete: vi.fn(async () => output),
  };
}

describe('VQA answer grounding', () => {
  it('asks the configured model with only selected-frame evidence', async () => {
    const grounding: VqaGroundingRepository = { find: vi.fn(async () => context([{
      evidence_id: 'caption-1', type: 'caption', start_ms: 4200, end_ms: 4300,
      snippet: 'A woman is holding a bottle.', producer: 'caption:v1',
    }, {
      evidence_id: 'object-1', type: 'object', start_ms: 4200, end_ms: 4300,
      snippet: 'bottle', producer: 'yolo:v1',
    }])) };
    const languageModel = model(JSON.stringify({
      answer_status: 'answered', answer: 'một chiếc chai', normalized_answer: 'một chiếc chai',
      confidence: { level: 'high', score: 0.91 },
    }));
    const service = new VqaAnswerService(grounding, languageModel);

    const result = await service.answer(input);

    expect(result).toMatchObject({
      query_id: 'query-1', video_id: 'video-1', original_frame_id: 42, timestamp_ms: 4200,
      answer_status: 'answered', answer: 'một chiếc chai', normalized_answer: 'một chiếc chai',
      evidence_ids: ['caption-1', 'object-1'], model_version: 'aic-qa-v1',
    });
    expect(vi.mocked(languageModel.complete).mock.calls[0][0].system.toLowerCase()).toContain('only the supplied evidence');
    expect(vi.mocked(languageModel.complete).mock.calls[0][0].system).toContain('Every key is mandatory');
    expect(vi.mocked(languageModel.complete).mock.calls[0][0].prompt).toContain('A woman is holding a bottle.');
    expect(vi.mocked(languageModel.complete).mock.calls[0][0].prompt).toContain('bottle');
  });

  it('abstains without calling the model when the selected frame has no evidence', async () => {
    const languageModel = model('should not be called');
    const service = new VqaAnswerService({ find: vi.fn(async () => context([])) }, languageModel);

    await expect(service.answer(input)).resolves.toMatchObject({
      answer_status: 'abstained', answer: null, normalized_answer: null, evidence_ids: [],
    });
    expect(languageModel.complete).not.toHaveBeenCalled();
  });

  it('converts malformed model output into a safe abstention', async () => {
    const service = new VqaAnswerService({ find: vi.fn(async () => context()) }, model('not-json'));

    await expect(service.answer(input)).resolves.toMatchObject({
      answer_status: 'abstained', answer: null, normalized_answer: null,
    });
  });

  it('uses a validated frontend LLM configuration for one answer request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer_status: 'answered', answer: 'a bottle', normalized_answer: 'a bottle',
        confidence: { level: 'high', score: 0.8 },
      }) } }],
    }), { status: 200 })));
    const service = new VqaAnswerService({ find: vi.fn(async () => context()) }, new UnavailableLanguageModel());

    await expect(service.answer({
      ...input,
      llm: {
        base_url: 'https://custom-llm.test/v1', api_key: 'request-secret', model: 'custom-v1',
        timeout_ms: 2_000, max_tokens: 64, temperature: 0.2,
      },
    })).resolves.toMatchObject({ answer_status: 'answered', model_version: 'custom-v1' });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://custom-llm.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer request-secret');
  });

  it('uses the signed keyframe thumbnail for multimodal VQA before text fallback', async () => {
    const vlm: VisionLanguageModel = {
      isConfigured: true,
      modelName: 'vision-v1',
      verifyImageRelevance: vi.fn(),
      answerVisualQuestion: vi.fn(async () => ({
        answer_status: 'answered', answer: 'a bottle', normalized_answer: 'a bottle',
        confidence: { level: 'high', score: 0.95 }, reason: 'visible in frame',
      })),
    };
    const storage = {
      isConfigured: true,
      signReadUrl: vi.fn(async (key: string) => `https://signed.test/${key}`),
      health: vi.fn(async () => true),
    };
    const service = new VqaAnswerService({ find: vi.fn(async () => context()) }, new UnavailableLanguageModel(), vlm, storage);

    await expect(service.answer(input)).resolves.toMatchObject({
      answer_status: 'answered', producer: 'vlm-vision-openai-compatible', model_version: 'vision-v1',
    });
    expect(storage.signReadUrl).toHaveBeenCalledWith('keyframes/video-1/42.jpg');
    expect(vlm.answerVisualQuestion).toHaveBeenCalledWith(expect.objectContaining({
      imageUrl: 'https://signed.test/keyframes/video-1/42.jpg',
    }));
  });

  it('uses the request VLM config when the injected VLM is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer_status: 'answered', answer: 'a bottle', normalized_answer: 'a bottle',
        confidence: { level: 'high', score: 0.8 },
      }) } }],
    }), { status: 200 })));
    const service = new VqaAnswerService(
      { find: vi.fn(async () => context()) }, new UnavailableLanguageModel(), undefined,
      { isConfigured: true, signReadUrl: vi.fn(async () => 'https://signed.test/frame.jpg'), health: vi.fn(async () => true) },
    );

    await expect(service.answer({
      ...input,
      vlm: {
        base_url: 'https://vision.test/v1', api_key: 'vision-secret', model: 'vision-v1',
        timeout_ms: 2_000, max_tokens: 256, temperature: 0,
      },
    })).resolves.toMatchObject({ answer_status: 'answered', producer: 'vlm-vision-openai-compatible' });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as { messages: Array<{ content: unknown }> };
    expect(body.messages[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' }),
    ]));
  });

  it('reports an unavailable grounding database as a service-unavailable response', async () => {
    await expect(new VqaAnswerService(new UnavailableVqaGroundingRepository(), model('{}')).answer(input))
      .rejects.toMatchObject({ status: 503 });
  });

  it('always accepts frontend-selected endpoints without a feature flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer_status: 'answered', answer: 'a bottle', normalized_answer: 'a bottle',
        confidence: { level: 'high', score: 0.8 },
      }) } }],
    }), { status: 200 })));
    const service = new VqaAnswerService(
      { find: vi.fn(async () => context()) },
      new UnavailableLanguageModel(),
    );
    await expect(service.answer({
      ...input,
      llm: {
        base_url: 'https://custom-llm.test/v1', model: 'custom-v1',
        timeout_ms: 2_000, max_tokens: 64, temperature: 0.2,
      },
    })).resolves.toMatchObject({ answer_status: 'answered', model_version: 'custom-v1' });
  });
});

describe('VQA answer request validation and grounding repository', () => {
  it('validates the answer request at the backend boundary', () => {
    expect(parseVqaAnswerRequest(input)).toEqual(input);
    expect(() => parseVqaAnswerRequest({ ...input, question: '' })).toThrow('question');
    expect(() => parseVqaAnswerRequest({ ...input, original_frame_id: -1 })).toThrow('original_frame_id');
    expect(() => parseVqaAnswerRequest({ ...input, query_id: 'bad id' })).toThrow('query_id');
    expect(() => parseVqaAnswerRequest({
      ...input,
      llm: { base_url: 'ftp://unsafe.test/v1', model: 'custom-v1' },
    })).toThrow('base_url');
    expect(parseVqaAnswerRequest({
      ...input,
      vlm: { base_url: 'https://vision.test/v1', model: 'vision-v1', timeout_ms: 2_000, max_tokens: 256, temperature: 0 },
    })).toMatchObject({ vlm: { base_url: 'https://vision.test/v1', model: 'vision-v1' } });
    expect(() => parseVqaAnswerRequest({
      ...input,
      vlm: { base_url: 'https://vision.test/v1', model: 'vision-v1', timeout_ms: 50, max_tokens: 256, temperature: 0 },
    })).toThrow('timeout_ms');
  });

  it('loads the VQA run, exact frame and evidence with one parameterized query', async () => {
    const database: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [{
        query_id: 'query-1', task: 'vqa', video_id: 'video-1', original_frame_id: 42, timestamp_ms: 4200,
        thumbnail_object_key: 'keyframes/video-1/42.jpg',
        evidence_id: 'caption-1', type: 'caption', start_ms: 4200, end_ms: 4300,
        snippet: 'A woman is holding a bottle.', producer: 'caption:v1',
      }] as never[], rowCount: 1 })),
    };

    const result = await new PostgresVqaGroundingRepository(database).find('query-1', 'video-1', 42);

    expect(result).toMatchObject({ query_id: 'query-1', task: 'vqa', timestamp_ms: 4200 });
    expect(result?.thumbnail_object_key).toBe('keyframes/video-1/42.jpg');
    expect(result?.evidence).toEqual([expect.objectContaining({ evidence_id: 'caption-1', snippet: 'A woman is holding a bottle.' })]);
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual(['query-1', 'video-1', 42]);
  });
});
