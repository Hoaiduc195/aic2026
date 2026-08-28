import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OpenAICompatibleVisionClient,
  UnavailableVisionLanguageModel,
} from '../src/compute/vlm-vision.client';
import { VlmRerankerService } from '../src/retrieval/vlm-reranker.service';
import type { BackendConfig } from '../src/common/config';
import type { FusedCandidate } from '../src/common/types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const clientOptions = {
  baseUrl: 'https://vision.test/v1',
  apiKey: 'request-secret',
  model: 'vision-v1',
  timeoutMs: 2_000,
  maxTokens: 256,
  temperature: 0,
};

function candidate(frameId: number, score: number): FusedCandidate {
  return {
    video_id: 'video-1',
    original_frame_id: frameId,
    start_ms: frameId * 100,
    end_ms: frameId * 100 + 100,
    preview_uri: `https://signed.test/frame-${frameId}.jpg`,
    score,
    evidence_ids: [`caption-${frameId}`],
    matched_modalities: ['embedding'],
    fusion_trace: [],
  };
}

function config(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    vlmEnabled: true,
    vlmTopK: 2,
    vlmWeight: 0.6,
    vlmConcurrency: 2,
    vlmMinScore: 0,
    vlmAdaptiveTopK: false,
    ...overrides,
  } as BackendConfig;
}

describe('OpenAI-compatible vision model', () => {
  it('sends one storyboard image and maps every cell back to its original frame id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        frames: [
          { id: 100, score: 10, match: false, reason: 'wrong scene' },
          { id: 125, score: 92, match: true, reason: 'target action' },
        ],
      }) } }],
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
    }), { status: 200 })));

    const result = await new OpenAICompatibleVisionClient({ ...clientOptions, imageDetail: 'low' })
      .verifyStoryboardRelevance({
        query: 'person closes a fuel cap',
        storyboardUrl: 'data:image/jpeg;base64,c3Rvcnlib2FyZA==',
        frameIds: [100, 125],
        columns: 2,
      });

    expect(result.frames).toEqual([
      expect.objectContaining({ id: 100, score: 10, match: false }),
      expect.objectContaining({ id: 125, score: 92, match: true }),
    ]);
    expect(result.usage?.total_tokens).toBe(220);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[1].content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('100, 125') }),
      expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ detail: 'low' }) }),
    ]);
  });

  it('uses a 15-second timeout when no timeout is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer_status: 'answered', answer: 'một cái chai', normalized_answer: 'một cái chai',
        confidence: { level: 'high', score: 0.9 },
      }) } }],
    }), { status: 200 })));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);

    await new OpenAICompatibleVisionClient({
      baseUrl: 'https://vision.test/v1',
      model: 'vision-v1',
    }).answerVisualQuestion({ question: 'Có gì trong ảnh?', imageUrl: 'https://signed.test/frame.jpg' });

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it('sends text and image_url content with bearer authentication', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer_status: 'answered',
                    answer: 'a bottle',
                    normalized_answer: 'a bottle',
                    confidence: { level: 'high', score: 0.9 },
                    reason: 'visible',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const client = new OpenAICompatibleVisionClient(clientOptions);
    const result = await client.answerVisualQuestion({
      question: 'What is the person holding?',
      imageUrl: 'https://signed.test/frame.jpg',
      evidenceText: '[caption][c1] A person is holding a bottle.',
    });

    expect(result).toMatchObject({ answer_status: 'answered', answer: 'a bottle', confidence: { score: 0.9 } });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://vision.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer request-secret');
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[1]).toMatchObject({ role: 'user' });
    expect(body.messages[0].content).toContain('primary source');
    expect(body.messages[0].content).toContain('supporting context');
    expect(body.messages[0].content).toContain('do not let it override');
    expect(body.messages[0].content).toContain('Always answer in Vietnamese');
    expect(body.messages[0].content).toContain('one short noun phrase or one short sentence');
    expect(body.messages[0].content).toContain('Không biết');
    expect(body.messages[0].content).toContain('non-empty string answer');
    expect(body.messages[1].content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image_url', image_url: { url: 'https://signed.test/frame.jpg' } },
    ]);
  });

  it('accepts JSON wrapped in a markdown fence for visual answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '```json\n{"answer_status":"abstained","answer":null,"normalized_answer":null,"confidence":{"level":"low","score":0.1}}\n```',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      new OpenAICompatibleVisionClient(clientOptions).answerVisualQuestion({
        question: 'What is shown?',
        imageUrl: 'https://signed.test/frame.jpg',
      }),
    ).resolves.toMatchObject({
      answer_status: 'abstained',
      answer: 'Không biết',
      normalized_answer: 'Không biết',
      confidence: { level: 'low' },
    });
  });

  it('verifies image relevance with scoring and reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    score: 85,
                    match: true,
                    reason: 'Keyframe clearly shows a person in red ao dai',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const client = new OpenAICompatibleVisionClient(clientOptions);
    const result = await client.verifyImageRelevance({
      query: 'người mặc áo dài đỏ',
      imageUrl: 'https://signed.test/frame.jpg',
    });

    expect(result).toEqual({
      score: 85,
      match: true,
      reason: 'Keyframe clearly shows a person in red ao dai',
    });
  });

  it('passes Luna reasoning effort and low-detail image settings when configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ score: 75, match: true, reason: 'visible' }) } }],
    }), { status: 200 })));
    const client = new OpenAICompatibleVisionClient({
      ...clientOptions,
      model: 'cx/gpt-5.6-luna',
      reasoningEffort: 'low',
      imageDetail: 'low',
    });

    await client.verifyImageRelevance({ query: 'person walking', imageUrl: 'https://signed.test/frame.jpg' });

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as {
      reasoning_effort?: string;
      max_completion_tokens?: number;
      max_tokens?: number;
      temperature?: number;
      response_format?: { type: string };
      messages: Array<{
        role: string;
        content: Array<{ type: string; image_url?: { url: string; detail?: string } }>;
      }>;
    };
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('developer');
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://signed.test/frame.jpg', detail: 'low' },
    });
  });

  it('scores a low-detail image grid and exposes provider token usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ frames: [
        { id: 10, score: 15, match: false, reason: 'not visible' },
        { id: 11, score: 92, match: true, reason: 'clear match' },
      ] }) } }],
      usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960, cost: 0.012 },
    }), { status: 200 })));
    const client = new OpenAICompatibleVisionClient({ ...clientOptions, imageDetail: 'low' });

    const result = await client.verifyImageBatchRelevance({
      query: 'person opens a red door',
      images: [
        { id: 10, imageUrl: 'data:image/jpeg;base64,b25l' },
        { id: 11, imageUrl: 'data:image/jpeg;base64,dHdv' },
      ],
    });

    expect(result.frames).toEqual([
      expect.objectContaining({ id: 10, score: 15, match: false }),
      expect.objectContaining({ id: 11, score: 92, match: true }),
    ]);
    expect(result.usage).toEqual({ input_tokens: 900, output_tokens: 60, total_tokens: 960, cost: 0.012 });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { detail?: string } }> }>;
    };
    expect(body.messages[1].content.filter((item) => item.type === 'image_url')).toHaveLength(2);
    expect(body.messages[1].content[2].image_url?.detail).toBe('low');
  });

  it('retries on 429 rate-limit response and succeeds on second attempt', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('Too Many Requests', { status: 429 });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ score: 70, match: true, reason: 'Match after retry' }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const client = new OpenAICompatibleVisionClient({
      ...clientOptions,
      timeoutMs: 60_000,
      retries: 1,
    });

    const resultPromise = client.verifyImageRelevance({
      query: 'test',
      imageUrl: 'https://signed.test/frame.jpg',
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.score).toBe(70);
    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it('retries an empty reasoning response with a larger bounded completion budget', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'length', message: { content: null } }],
          usage: { prompt_tokens: 100, completion_tokens: 128, total_tokens: 228 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: {
          content: JSON.stringify({ score: 82, match: true, reason: 'visible after retry' }),
        } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200 });
    }));
    const client = new OpenAICompatibleVisionClient({
      ...clientOptions,
      model: 'gpt-5.6-luna',
      maxTokens: 128,
      retries: 1,
      reasoningEffort: 'low',
    });

    const resultPromise = client.verifyImageRelevance({
      query: 'person at a fuel station',
      imageUrl: 'https://signed.test/frame.jpg',
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({ score: 82, match: true });
    expect(result.usage).toEqual({ input_tokens: 200, output_tokens: 148, total_tokens: 348 });
    expect(callCount).toBe(2);
    const firstBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as {
      max_completion_tokens: number;
    };
    const secondBody = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)) as {
      max_completion_tokens: number;
    };
    expect(firstBody.max_completion_tokens).toBe(128);
    expect(secondBody.max_completion_tokens).toBe(256);
    vi.useRealTimers();
  });

  it('returns an unavailable implementation without making a request', async () => {
    const model = new UnavailableVisionLanguageModel();
    expect(model.isConfigured).toBe(false);
    await expect(
      model.answerVisualQuestion({ question: 'q', imageUrl: 'https://signed.test/frame.jpg' }),
    ).rejects.toThrow('not configured');
    await expect(
      model.verifyImageRelevance({ query: 'q', imageUrl: 'https://signed.test/frame.jpg' }),
    ).rejects.toThrow('not configured');
  });
});

describe('VLM reranking', () => {
  it('reranks only the configured top-k and records the visual trace', async () => {
    const vlm = {
      isConfigured: true,
      modelName: 'vision-v1',
      verifyImageRelevance: vi.fn(async ({ imageUrl }: { imageUrl: string }) => ({
        score: imageUrl.includes('frame-2') ? 100 : 0,
        match: true,
        reason: imageUrl.includes('frame-2') ? 'strong match' : 'weak match',
      })),
      answerVisualQuestion: vi.fn(),
    };
    const service = new VlmRerankerService(config(), vlm);
    const result = await service.rerank('a person with a bottle', [
      candidate(1, 0.8),
      candidate(2, 0.7),
      candidate(3, 0.6),
    ]);

    expect(result.map((item) => item.original_frame_id)).toEqual([2, 1, 3]);
    expect(vlm.verifyImageRelevance).toHaveBeenCalledTimes(2);
    expect(result[0].matched_modalities).toContain('vlm_rerank');
    expect(result[0].fusion_trace[0]).toMatchObject({
      branch: 'vlm_rerank',
      vlm_score: 100,
      vlm_reason: 'strong match',
    });
  });

  it('filters out candidates below min score threshold when configured', async () => {
    const vlm = {
      isConfigured: true,
      modelName: 'vision-v1',
      verifyImageRelevance: vi.fn(async ({ imageUrl }: { imageUrl: string }) => ({
        score: imageUrl.includes('frame-2') ? 90 : 20,
        match: imageUrl.includes('frame-2'),
        reason: imageUrl.includes('frame-2') ? 'good' : 'poor',
      })),
      answerVisualQuestion: vi.fn(),
    };
    const service = new VlmRerankerService(config({ vlmTopK: 3, vlmMinScore: 50 }), vlm);
    const result = await service.rerank('query', [
      candidate(1, 0.8),
      candidate(2, 0.7),
    ]);

    // frame-1 had score 20 (< 50 min score), so it was filtered out
    expect(result.map((item) => item.original_frame_id)).toEqual([2]);
  });

  it('keeps original candidates when disabled or when the provider fails', async () => {
    const vlm = {
      isConfigured: true,
      modelName: 'vision-v1',
      verifyImageRelevance: vi.fn(async () => {
        throw new Error('provider down');
      }),
      answerVisualQuestion: vi.fn(),
    };
    const input = [candidate(1, 0.8)];
    const service = new VlmRerankerService(config(), vlm);

    await expect(service.rerank('q', input, { enabled: false })).resolves.toEqual(input);
    await expect(service.rerank('q', input)).resolves.toEqual(input);
    expect(vlm.verifyImageRelevance).toHaveBeenCalledTimes(1);
  });
});
