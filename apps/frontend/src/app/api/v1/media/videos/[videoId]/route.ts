import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { NextRequest, NextResponse } from 'next/server';

import { parseByteRange } from '../../../../../../lib/media-adapter';
import { getVideoAsset } from '../../../../../../lib/server-media';
import { protectMediaRequest } from '../../../../../../lib/server-media-access';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const accessError = protectMediaRequest(request);
  if (accessError) return accessError;
  try {
    const { videoId } = await context.params;
    const asset = await getVideoAsset(videoId);
    const rangeHeader = request.headers.get('range');
    const range = rangeHeader ? parseByteRange(rangeHeader, asset.size) : { start: 0, end: asset.size - 1 };
    if (!range) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'content-range': `bytes */${asset.size}` },
      });
    }

    const stream = Readable.toWeb(createReadStream(asset.path, { start: range.start, end: range.end })) as ReadableStream;
    const partial = Boolean(rangeHeader);
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': String(range.end - range.start + 1),
        'content-type': 'video/mp4',
        ...(partial ? { 'content-range': `bytes ${range.start}-${range.end}/${asset.size}` } : {}),
      },
    });
  } catch {
    return NextResponse.json({ message: 'Không tìm thấy video.' }, { status: 404 });
  }
}
