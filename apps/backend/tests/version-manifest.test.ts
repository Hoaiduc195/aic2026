import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/common/config';
import { createVersionManifest } from '../src/common/version-manifest';

describe('runtime version identity', () => {
  it('creates a traceable staged manifest without pretending an index is active', () => {
    const manifest = createVersionManifest(loadConfig(), new Date('2026-08-15T00:00:00Z'));
    expect(manifest).toMatchObject({
      dataset_id: 'aic2026', index_version: 'not-configured', status: 'staged',
      artifact_versions: { retrieval_input: 'preprocessing-artifacts' },
    });
    expect(manifest.model_versions.object).toBe('yolo26n-coco');
  });

  it('refuses to mark a version active without an index checksum', () => {
    const config = { ...loadConfig(), versionStatus: 'active' as const, indexVersion: 'idx-v1', indexChecksum: undefined };
    expect(() => createVersionManifest(config)).toThrow(/checksum/);
  });
});
