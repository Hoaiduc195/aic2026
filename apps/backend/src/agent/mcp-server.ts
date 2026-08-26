/**
 * Stdio MCP bridge for an external agent (Codex, Claude, etc.).
 *
 * The bridge deliberately exposes the bounded verification API instead of
 * exposing PostgreSQL, R2 credentials or raw artifacts to the model.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const backendUrl = (process.env.BACKEND_URL?.trim() || 'http://localhost:4000').replace(/\/+$/, '');
const backendOperatorToken = process.env.BACKEND_OPERATOR_TOKEN?.trim();
const timeoutMs = Number.isSafeInteger(Number(process.env.AGENT_TOOL_TIMEOUT_MS))
  ? Math.max(1_000, Math.min(120_000, Number(process.env.AGENT_TOOL_TIMEOUT_MS)))
  : 30_000;
const maxImageBytes = Number.isSafeInteger(Number(process.env.AGENT_MAX_IMAGE_BYTES))
  ? Math.max(64 * 1024, Math.min(4 * 1024 * 1024, Number(process.env.AGENT_MAX_IMAGE_BYTES)))
  : 2 * 1024 * 1024;

async function backendJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${backendUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(backendOperatorToken ? { authorization: `Bearer ${backendOperatorToken}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message: unknown }).message)
      : `backend returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : 'tool failed' }) }],
  };
}

async function imageBlock(url: string): Promise<{
  type: 'image'; data: string; mimeType: string;
} | null> {
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(length) && length > maxImageBytes) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxImageBytes) return null;
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
    const mimeType = contentType && /^image\/(jpeg|png|webp|gif)$/.test(contentType)
      ? contentType
      : 'image/jpeg';
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType,
    };
  } catch {
    // A missing thumbnail must not make the whole verification run fail.
    return null;
  }
}

async function batchResult(payload: any, includeImages: boolean) {
  if (!includeImages || !payload || typeof payload !== 'object' || !payload.batch
    || !Array.isArray(payload.batch.frames)) {
    return result(payload);
  }

  const images = await Promise.all(payload.batch.frames.map((frame: any) => (
    typeof frame?.thumbnail_uri === 'string' ? imageBlock(frame.thumbnail_uri) : Promise.resolve(null)
  )));
  const frames = payload.batch.frames.map((frame: any, index: number) => {
    const { thumbnail_uri: _thumbnailUri, ...metadata } = frame;
    return { ...metadata, image_index: images[index] ? index : null };
  });
  const safePayload = { ...payload, batch: { ...payload.batch, frames } };
  const content: any[] = [{ type: 'text', text: JSON.stringify(safePayload) }];
  images.forEach((image, index) => {
    if (image) content.push({ type: 'text', text: `image_index=${index}` }, image);
  });
  return { content };
}

const server = new McpServer({ name: 'aic2026-frame-verification', version: '0.1.0' });
// The SDK's deeply recursive Zod generics can exceed TypeScript's instantiation
// depth in this NestJS project. Runtime validation is still provided by Zod;
// keep the registration boundary intentionally untyped.
const registerTool: any = server.registerTool.bind(server);

registerTool('start_frame_verification', {
  description: 'Run feature retrieval, rank distinct source videos, and create an exhaustive keyframe verification run.',
  inputSchema: {
    query: z.string().min(1).max(2000),
    task: z.enum(['textual_kis', 'vqa', 'trake']).default('textual_kis'),
    top_k: z.number().int().min(1).max(100).default(20),
    video_budget: z.number().int().min(1).max(50).default(10),
    frame_batch_size: z.number().int().min(1).max(32).default(8),
  },
}, async ({ query, task, top_k, video_budget, frame_batch_size }: any) => {
  try {
    return result(await backendJson('/v1/agent/frame-search', {
      method: 'POST',
      body: JSON.stringify({ query, task, top_k, video_budget, frame_batch_size }),
    }));
  } catch (error) {
    return failure(error);
  }
});

registerTool('get_next_frame_batch', {
  description: 'Get the next bounded batch of signed keyframe thumbnails for the current verification run.',
  inputSchema: {
    run_id: z.string().min(1).max(100),
    include_images: z.boolean().default(true),
  },
}, async ({ run_id, include_images }: any) => {
  try {
    const payload = await backendJson(`/v1/agent/frame-search/${encodeURIComponent(run_id)}/batch`);
    return await batchResult(payload, include_images !== false);
  } catch (error) {
    return failure(error);
  }
});

registerTool('submit_frame_judgments', {
  description: 'Submit one relevance judgment for every frame in the pending batch. All frames are required exactly once.',
  inputSchema: {
    run_id: z.string().min(1).max(100),
    judgments: z.array(z.object({
      video_id: z.string().min(1).max(200),
      original_frame_id: z.number().int().min(0),
      relevant: z.boolean(),
      score: z.number().min(0).max(1).optional(),
      reason: z.string().max(200).optional(),
    })).min(1).max(32),
  },
}, async ({ run_id, judgments }: any) => {
  try {
    return result(await backendJson(`/v1/agent/frame-search/${encodeURIComponent(run_id)}/judgments`, {
      method: 'POST', body: JSON.stringify({ judgments }),
    }));
  } catch (error) {
    return failure(error);
  }
});

registerTool('get_frame_verification_status', {
  description: 'Read verification progress and coverage for a run.',
  inputSchema: { run_id: z.string().min(1).max(100) },
}, async ({ run_id }: any) => {
  try {
    return result(await backendJson(`/v1/agent/frame-search/${encodeURIComponent(run_id)}`));
  } catch (error) {
    return failure(error);
  }
});

registerTool('stop_frame_verification', {
  description: 'Stop a verification run while preserving its checkpoint and judgments.',
  inputSchema: { run_id: z.string().min(1).max(100) },
}, async ({ run_id }: any) => {
  try {
    return result(await backendJson(`/v1/agent/frame-search/${encodeURIComponent(run_id)}/stop`, { method: 'POST' }));
  } catch (error) {
    return failure(error);
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'MCP server failed');
  process.exitCode = 1;
});
