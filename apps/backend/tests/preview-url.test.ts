import { describe, expect, it, vi } from 'vitest';

import type { ObjectStorage } from '../src/storage/object-storage';
import { previewObjectKey, signPreviewUris } from '../src/storage/preview-url';

function storage(isConfigured: boolean): ObjectStorage {
  return {
    isConfigured,
    signReadUrl: vi.fn(async (key: string) => `https://signed/${key}`),
    health: vi.fn(async () => isConfigured),
  };
}

describe('preview URL helpers', () => {
  it('extracts only non-empty internal R2 object keys', () => {
    expect(previewObjectKey('r2://media/keyframes/v/1.jpg')).toBe('keyframes/v/1.jpg');
    expect(previewObjectKey('r2://media/')).toBeUndefined();
    expect(previewObjectKey('https://signed/keyframes/v/1.jpg')).toBeUndefined();
    expect(previewObjectKey(undefined)).toBeUndefined();
  });

  it('leaves references unchanged when storage is unavailable or not internal', async () => {
    const unavailable = storage(false);
    const items = [{ preview_uri: 'r2://media/keyframes/v/1.jpg' }, { preview_uri: 'https://existing/item' }];
    await expect(signPreviewUris(items, unavailable)).resolves.toEqual(items);
    expect(vi.mocked(unavailable.signReadUrl)).not.toHaveBeenCalled();

    const configured = storage(true);
    const external = [{ preview_uri: 'https://existing/item' }, {}];
    await expect(signPreviewUris(external, configured)).resolves.toEqual(external);
    expect(vi.mocked(configured.signReadUrl)).not.toHaveBeenCalled();
  });
});
