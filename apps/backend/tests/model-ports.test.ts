import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HttpQueryEmbeddingProvider,
  OpenAICompatibleLanguageModel,
  UnavailableLanguageModel,
  UnavailableQueryEmbeddingProvider,
} from '../src/compute/model-ports';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('query embedding providers', () => {
  it('calls an external encoder with optional bearer auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })));
    const provider = new HttpQueryEmbeddingProvider('https://encoder.test/embed', 2, 'secret');
    await expect(provider.embedText('a bike')).resolves.toEqual([0.1, 0.2]);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer secret' });
  });

  it('sends raw frame bytes to the image encoder endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })));
    const provider = new HttpQueryEmbeddingProvider('https://encoder.test/embed', 2, 'secret');
    await expect(provider.embedImage(Uint8Array.from([1, 2, 3]), 'image/jpeg')).resolves.toEqual([0.1, 0.2]);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://encoder.test/embed/image');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('image/jpeg');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
    expect(init?.body).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('rejects failed or malformed encoder responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    await expect(new HttpQueryEmbeddingProvider('https://encoder.test', 2).embedText('x')).rejects.toThrow('HTTP 502');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ embedding: [Number.NaN] }))));
    await expect(new HttpQueryEmbeddingProvider('https://encoder.test', 2).embedText('x')).rejects.toThrow('2 finite');
    await expect(new UnavailableQueryEmbeddingProvider().embedText('x')).rejects.toThrow('not configured');
  });

  it('calls an OpenAI-compatible chat completions endpoint with a bearer token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer_status":"answered"}' } }],
    }), { status: 200 })));
    const provider = new OpenAICompatibleLanguageModel({
      baseUrl: 'https://llm.test/v1', model: 'aic-qa', apiKey: 'llm-secret',
      timeoutMs: 1500, maxTokens: 128, temperature: 0,
    });

    await expect(provider.complete({ system: 'system prompt', prompt: 'user prompt' }))
      .resolves.toBe('{"answer_status":"answered"}');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://llm.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer llm-secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'aic-qa',
      temperature: 0,
      max_tokens: 128,
      response_format: { type: 'json_object' },
      stream: false,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
  });

  it('supports OpenAI content blocks and rejects malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: 'text', text: 'hello' }] } }],
    }), { status: 200 })));
    const provider = new OpenAICompatibleLanguageModel({ baseUrl: 'https://llm.test', model: 'aic-qa' });
    await expect(provider.complete({ system: 's', prompt: 'p' })).resolves.toBe('hello');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(provider.complete({ system: 's', prompt: 'p' })).rejects.toThrow('content');
    await expect(new UnavailableLanguageModel().complete({ system: 's', prompt: 'p' }))
      .rejects.toThrow('not configured');
  });

  it('sends a downloaded keyframe data URL as an image content block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer_status":"answered"}' } }],
    }), { status: 200 })));
    const provider = new OpenAICompatibleLanguageModel({ baseUrl: 'https://llm.test/v1', model: 'aic-qa' });

    await provider.complete({
      system: 'system prompt',
      prompt: 'Question: What is visible?',
      imageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    });

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'Question: What is visible?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } },
    ]);
  });
});
