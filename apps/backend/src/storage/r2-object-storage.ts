import { GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { ObjectStorage } from './object-storage';

export interface R2StorageOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly signedUrlTtlSeconds: number;
}

export class R2ObjectStorage implements ObjectStorage {
  readonly isConfigured = true;
  private readonly client: S3Client;

  constructor(private readonly options: R2StorageOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
    });
  }

  async signReadUrl(objectKey: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey }), {
      expiresIn: this.options.signedUrlTtlSeconds,
    });
  }

  async health(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}
