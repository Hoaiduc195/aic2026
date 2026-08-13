export interface ObjectStorage {
  readonly isConfigured: boolean;
  signReadUrl(objectKey: string): Promise<string>;
  health(): Promise<boolean>;
}

export class UnavailableObjectStorage implements ObjectStorage {
  readonly isConfigured = false;

  async signReadUrl(_objectKey: string): Promise<string> {
    throw new Error('R2 object storage is not configured');
  }

  async health(): Promise<boolean> {
    return false;
  }
}
