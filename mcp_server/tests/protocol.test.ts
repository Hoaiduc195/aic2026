import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

const servers: ReturnType<typeof createHttpServer>[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('MCP stdio protocol', () => {
  it('lists AIC tools and serves an exact frame call', async () => {
    const backend = createHttpServer((request, response) => mockBackend(request, response));
    servers.push(backend);
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', () => resolve()));
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('mock backend did not bind to a TCP port');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        AIC_BACKEND_URL: `http://127.0.0.1:${address.port}`,
        MCP_REQUEST_TIMEOUT_MS: '3000',
      },
    });
    const client = new Client({ name: 'aic-mcp-test-client', version: '0.1.0' });
    clients.push(client);
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'search_frames', 'plan_search', 'get_frame', 'get_frame_image', 'get_frame_context_batch', 'get_video_studio', 'get_video_context',
      'suggest_vqa_answer', 'get_candidates', 'get_selection', 'preview_submission', 'prepare_top100_focus_csv', 'parse_submission_csv', 'search_loop', 'get_search_session', 'check_trake_sequence', 'trace_answer',
    ]));
    expect(listed.tools.some((tool) => tool.name === 'improve_query')).toBe(false);
    expect(listed.tools.find((tool) => tool.name === 'search_frames')?.description).toMatch(/query.*English/i);
    expect(listed.tools.find((tool) => tool.name === 'search_loop')?.description).toMatch(/Vietnamese.*English|English.*Vietnamese/i);
    expect(listed.tools.find((tool) => tool.name === 'trace_answer')?.description).toMatch(/original language/i);

    const invalidTrake = await client.callTool({ name: 'search_loop', arguments: {
      task: 'trake', query: 'lions, then staff weigh an animal',
    } });
    expect(invalidTrake.isError).toBe(true);
    expect(String(invalidTrake.content[0]?.type === 'text' ? invalidTrake.content[0].text : ''))
      .toMatch(/explicitly numbered event descriptions/iu);

    const result = await client.callTool({ name: 'get_frame', arguments: { videoId: 'v-1', originalFrameId: 10 } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(String(result.content[0].type === 'text' ? result.content[0].text : ''))).toMatchObject({
      video_id: 'v-1',
      original_frame_id: 10,
      is_exact_frame: true,
    });

    const context = await client.callTool({ name: 'get_frame_context_batch', arguments: {
      frames: [{ videoId: 'v-1', originalFrameId: 10 }], includeImages: true,
    } });
    expect(context.isError).not.toBe(true);
    expect(context.content.some((item) => item.type === 'image')).toBe(true);

    const prepared = await client.callTool({ name: 'prepare_top100_focus_csv', arguments: {
      queryId: 'query-1',
      focusCount: 20,
      candidates: Array.from({ length: 100 }, (_, index) => ({
        videoId: 'v-1', originalFrameId: index + 10, score: 1 - index / 1000, sourceRank: index + 1,
      })),
    } });
    expect(prepared.isError).not.toBe(true);
    expect(JSON.parse(String(prepared.content[0].type === 'text' ? prepared.content[0].text : ''))).toMatchObject({
      focusVideoId: 'v-1',
      focusFrameCount: 20,
      requestedFocusCount: 20,
      rowCount: 100,
      targetRowCount: 100,
    });
  }, 15_000);
});

function mockBackend(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('content-type', 'application/json');
  const frameMatch = request.url?.match(/^\/v1\/videos\/v-1\/frames\/(\d+)$/u);
  if (frameMatch) {
    const originalFrameId = Number(frameMatch[1]);
    response.end(JSON.stringify({
      video_id: 'v-1',
      keyframe_no: null,
      original_frame_id: originalFrameId,
      timestamp_ms: originalFrameId * 40,
      captions: [],
      ocr: [{ evidence_id: 'ocr-1', text: 'umbrella', language: 'en', producer: 'test' }],
      objects: [],
      thumbnail_uri: 'http://signed/frame.jpg',
      is_exact_frame: true,
      annotation_source_frame_id: 10,
      asr_spans: [],
    }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/submissions/preview') {
    response.end(JSON.stringify({
      query_id: 'query-1',
      task: 'textual_kis',
      answer_count: 100,
      answers: [],
      csv: Array.from({ length: 100 }, (_, index) => `v-1,${index + 10}`).join('\r\n') + '\r\n',
      submittable: true,
      warnings: [],
    }));
    return;
  }
  if (request.url === '/v1/videos/v-1/frames/10/thumbnail') {
    response.setHeader('content-type', 'image/jpeg');
    response.end(Buffer.from([255, 216, 255]));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: 'not found' }));
}
