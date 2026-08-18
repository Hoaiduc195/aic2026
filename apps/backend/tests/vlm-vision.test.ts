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
    ...overrides,
  } as BackendConfig;
}

describe('OpenAI-compatible vision model', () => {
  it('sends text and image_url content with bearer authentication', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer_status: 'answered', answer: 'a bottle', normalized_answer: 'a bottle',
        confidence: { level: 'high', score: 0.9 }, reason: 'visible',
      }) } }],
    }), { status: 200 })));

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
    expect(body.messages[1].content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image_url', image_url: { url: 'https://signed.test/frame.jpg' } },
    ]);
  });

  it('accepts JSON wrapped in a markdown fence for visual answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n{"answer_status":"abstained","answer":null,"normalized_answer":null,"confidence":{"level":"low","score":0.1}}\n```' } }],
    }), { status: 200 })));

    await expect(new OpenAICompatibleVisionClient(clientOptions).answerVisualQuestion({
      question: 'What is shown?', imageUrl: 'https://signed.test/frame.jpg',
    })).resolves.toMatchObject({ answer_status: 'abstained', confidence: { level: 'low' } });
  });

  it('returns an unavailable implementation without making a request', async () => {
    const model = new UnavailableVisionLanguageModel();
    expect(model.isConfigured).toBe(false);
    await expect(model.answerVisualQuestion({ question: 'q', imageUrl: 'https://signed.test/frame.jpg' }))
      .rejects.toThrow('not configured');
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
    const result = await service.rerank('a person with a bottle', [candidate(1, 0.8), candidate(2, 0.7), candidate(3, 0.6)]);

    expect(result.map((item) => item.original_frame_id)).toEqual([2, 1, 3]);
    expect(vlm.verifyImageRelevance).toHaveBeenCalledTimes(2);
    expect(result[0].matched_modalities).toContain('vlm_rerank');
    expect(result[0].fusion_trace[0]).toMatchObject({ branch: 'vlm_rerank', vlm_score: 100, vlm_reason: 'strong match' });
  });

  it('keeps original candidates when disabled or when the provider fails', async () => {
    const vlm = {
      isConfigured: true,
      modelName: 'vision-v1',
      verifyImageRelevance: vi.fn(async () => { throw new Error('provider down'); }),
      answerVisualQuestion: vi.fn(),
    };
    const input = [candidate(1, 0.8)];
    const service = new VlmRerankerService(config(), vlm);

    await expect(service.rerank('q', input, { enabled: false })).resolves.toEqual(input);
    await expect(service.rerank('q', input)).resolves.toEqual(input);
    expect(vlm.verifyImageRelevance).toHaveBeenCalledTimes(1);
  });
});
