import type { ObjectStorage } from './object-storage';

/** Internal marker used for an R2 object key before a response URL is signed. */
export const INTERNAL_PREVIEW_URI_PREFIX = 'r2://media/';

export function previewObjectKey(previewUri: string | undefined): string | undefined {
  if (!previewUri?.startsWith(INTERNAL_PREVIEW_URI_PREFIX)) return undefined;
  const objectKey = previewUri.slice(INTERNAL_PREVIEW_URI_PREFIX.length);
  return objectKey || undefined;
}

export function withPreviewReferences<
  T extends { readonly preview_uri?: string; readonly video_object_key?: string | null },
>(items: readonly T[]): T[] {
  return items.map((item) => (
    item.preview_uri || !item.video_object_key
      ? item
      : { ...item, preview_uri: `${INTERNAL_PREVIEW_URI_PREFIX}${item.video_object_key}` } as T
  ));
}

export async function signPreviewUris<T extends { readonly preview_uri?: string }>(
  items: readonly T[],
  storage: ObjectStorage,
): Promise<T[]> {
  return Promise.all(items.map(async (item) => {
    if (!storage.isConfigured) return item;
    const objectKey = previewObjectKey(item.preview_uri);
    if (!objectKey) return item;
    return { ...item, preview_uri: await storage.signReadUrl(objectKey) } as T;
  }));
}
