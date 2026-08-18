import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendConfig } from '../src/common/config';
import type { FusedCandidate } from '../src/common/types';
import {
  OpenAICompatibleVisionClient,
  UnavailableVisionLanguageModel,
  type VisionLanguageModel,
} from '../src/compute/vlm-vision.client';
import { VlmRerankerService } from '../src/retrieval/vlm-reranker.service';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mockConfig: BackendConfig = {
  datasetId: 'aic2026',
  port: 4000,
  corsOrigins: ['http://localhost:3000'],
  allowUnauthenticatedLocal: true,
  r2Region: 'auto',
  signedUrlTtlSeconds: 900,
  embeddingDimensions: 1024,
  llmTimeoutMs: 15000,
  llmMaxTokens: 128,
  llmTemperature: 0,
  vlmEnabled: true,
  vlmBaseUrl: 'https://vlm.test/v1',
  vlmApiKey: 'vlm-secret',
  vlmModel: 'Qwen/Qwen2.5-VL-7B-Instruct',
  vlmTimeoutMs: 3000,
  vlmTopK: 5,
  vlmWeight: 0.6,
  vlmConcurrency: 3,
  datasetVersion: 'aic2026',
  pipelineVersion: 'preprocessing-artifacts',
  indexVersion: 'aic2026-local-v1',
  schemaVersion: '1.0.0',
  artifactVersion: 'preprocessing-artifacts',
  modelVersions: { visual: 'vit-h-14-clipa-336' },
  versionStatus: 'active',
};

function createCandidate(id: number, score: number): FusedCandidate {
  return {
    video_id: `L29_V00${id}`,
    keyframe_no: id * 10,
    original_frame_id: id * 100,
    start_ms: id * 1000,
    end_ms: id * 1000 + 1,
    preview_uri: `https://storage.test/media/frame_${id}.jpg`,
    score,
    evidence_ids: [`evidence_${id}`],
    matched_modalities: ['embedding'],
    fusion_trace: [
      {
        branch: 'clip',
        channel_rank: id,
        channel_weight: 1,
        rrf_contribution: score,
        aggregated_raw_score: score * 10,
        occurrence_count: 1,
        evidence_ids: [`evidence_${id}`],
        matched_terms: [],
      },
    ],
  };
}

describe('OpenAICompatibleVisionClient', () => {
  it('calls the OpenAI-compatible Vision chat endpoint with multimodal image payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      score: 95,
                      match: true,
                      reason: 'Mô tả người phụ nữ mặc áo dài đỏ hoàn toàn khớp',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const client = new OpenAICompatibleVisionClient({
      baseUrl: 'https://vlm.test/v1',
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
      apiKey: 'test-key',
      timeoutMs: 2000,
    });

    const result = await client.verifyImageRelevance({
      query: 'người phụ nữ mặc áo dài đỏ',
      imageUrl: 'https://r2.test/frame.jpg',
    });

    expect(result).toEqual({
      score: 95,
      match: true,
      reason: 'Mô tả người phụ nữ mặc áo dài đỏ hoàn toàn khớp',
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://vlm.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');

    const body = JSON.parse(String(init?.body));
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: expect.stringContaining('người phụ nữ mặc áo dài đỏ') },
      { type: 'image_url', image_url: { url: 'https://r2.test/frame.jpg' } },
    ]);
    // Verify Gemini 3.x compatible token parameter is used
    expect(body).toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('handles markdown json wrapping and recovers gracefully from invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '```json\n{"score": 80, "match": true, "reason": "Phù hợp"}\n```',
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const client = new OpenAICompatibleVisionClient({
      baseUrl: 'https://vlm.test/v1',
      model: 'gemini-3.7-flash',
    });

    const result = await client.verifyImageRelevance({
      query: 'áo dài',
      imageUrl: 'https://r2.test/img.jpg',
    });

    expect(result.score).toBe(80);
    expect(result.match).toBe(true);
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
            choices: [{ message: { content: JSON.stringify({ score: 70, match: true, reason: 'Match after retry' }) } }],
          }),
          { status: 200 },
        );
      }),
    );

    const client = new OpenAICompatibleVisionClient({
      baseUrl: 'https://vlm.test/v1',
      model: 'gemini-3.7-flash',
      timeoutMs: 60_000,
      retries: 1,
    });

    const resultPromise = client.verifyImageRelevance({ query: 'test', imageUrl: 'https://r2.test/img.jpg' });
    // Fast-forward the 8s retry delay
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.score).toBe(70);
    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it('answers visual questions with confidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      answer_status: 'answered',
                      answer: 'màu đỏ',
                      normalized_answer: 'màu đỏ',
                      confidence: { level: 'high', score: 0.96 },
                      reason: 'Trang phục có màu đỏ tươi',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const client = new OpenAICompatibleVisionClient({
      baseUrl: 'https://vlm.test/v1',
      model: 'Qwen/Qwen2.5-VL-7B-Instruct',
    });

    const answer = await client.answerVisualQuestion({
      question: 'Chiếc áo có màu gì?',
      imageUrl: 'https://r2.test/image.jpg',
    });

    expect(answer).toEqual({
      answer_status: 'answered',
      answer: 'màu đỏ',
      normalized_answer: 'màu đỏ',
      confidence: { level: 'high', score: 0.96 },
      reason: 'Trang phục có màu đỏ tươi',
    });
  });

  it('rejects calls on unavailable vision model', async () => {
    const unavailable = new UnavailableVisionLanguageModel();
    await expect(
      unavailable.verifyImageRelevance(),
    ).rejects.toThrow('not configured');
  });
});

describe('VlmRerankerService', () => {
  it('reranks top candidates based on VLM visual relevance scores', async () => {
    const mockVlm: VisionLanguageModel = {
      isConfigured: true,
      modelName: 'test-vlm',
      verifyImageRelevance: vi.fn(async ({ imageUrl }) => {
        // Candidate 2 gets high score, Candidate 1 gets low score
        if (imageUrl.includes('frame_2')) {
          return { score: 95, match: true, reason: 'Rất phù hợp' };
        }
        if (imageUrl.includes('frame_1')) {
          return { score: 10, match: false, reason: 'Không phù hợp' };
        }
        return { score: 50, match: false, reason: 'Trung bình' };
      }),
      answerVisualQuestion: vi.fn(),
    };

    const reranker = new VlmRerankerService(mockConfig, mockVlm);

    // Initial order: Candidate 1 (score 0.020), Candidate 2 (score 0.018)
    const candidates = [createCandidate(1, 0.02), createCandidate(2, 0.018), createCandidate(3, 0.01)];

    const result = await reranker.rerank('áo dài đỏ', candidates);

    // Candidate 2 should be boosted above Candidate 1
    expect(result[0].video_id).toBe('L29_V002');
    expect(result[1].video_id).toBe('L29_V001');
    expect(result[0].matched_modalities).toContain('vlm_rerank');
    expect(result[0].fusion_trace[0].branch).toBe('vlm_rerank');
    expect(result[0].fusion_trace[0].vlm_score).toBe(95);
  });

  it('bypasses reranking when VLM is disabled or unconfigured', async () => {
    const mockVlm: VisionLanguageModel = {
      isConfigured: false,
      modelName: 'unconfigured',
      verifyImageRelevance: vi.fn(),
      answerVisualQuestion: vi.fn(),
    };

    const reranker = new VlmRerankerService(mockConfig, mockVlm);
    const candidates = [createCandidate(1, 0.02), createCandidate(2, 0.018)];

    const result = await reranker.rerank('query', candidates);
    expect(result).toEqual(candidates);
    expect(mockVlm.verifyImageRelevance).not.toHaveBeenCalled();
  });

  it('handles candidate errors gracefully without crashing the pipeline', async () => {
    const mockVlm: VisionLanguageModel = {
      isConfigured: true,
      modelName: 'failing-vlm',
      verifyImageRelevance: vi.fn(async () => {
        throw new Error('VLM rate limit');
      }),
      answerVisualQuestion: vi.fn(),
    };

    const reranker = new VlmRerankerService(mockConfig, mockVlm);
    const candidates = [createCandidate(1, 0.02), createCandidate(2, 0.018)];

    const result = await reranker.rerank('query', candidates);
    expect(result[0].video_id).toBe('L29_V001');
    expect(result[1].video_id).toBe('L29_V002');
  });
});
