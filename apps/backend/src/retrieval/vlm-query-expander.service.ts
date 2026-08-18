import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { APP_CONFIG, VISION_LANGUAGE_MODEL } from '../common/tokens';
import type { BackendConfig } from '../common/config';
import type { VisionLanguageModel } from '../compute/vlm-vision.client';

/**
 * VlmQueryExpanderService
 *
 * Calls the VLM API with a TEXT-ONLY prompt (no image) to generate additional
 * English query variants from the original user query.
 *
 * These variants are injected into the retrieval plan's query_variants so that
 * each branch searches with multiple phrasings and the results are merged via RRF.
 *
 * Token cost: ~300 tokens per call (no image tile cost).
 */
@Injectable()
export class VlmQueryExpanderService {
  private readonly logger = new Logger(VlmQueryExpanderService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: BackendConfig,
    @Optional() @Inject(VISION_LANGUAGE_MODEL) private readonly vlm?: VisionLanguageModel,
  ) {}

  get isConfigured(): boolean {
    return Boolean(
      this.config.vlmQueryExpansion &&
        this.vlm?.isConfigured &&
        this.config.vlmBaseUrl &&
        this.config.vlmApiKey,
    );
  }

  /**
   * Generates additional English query variants for a given query.
   * Returns an empty array if expansion is disabled or VLM is not configured.
   */
  async expand(query: string): Promise<string[]> {
    if (!this.isConfigured) return [];

    try {
      const variants = await this.callExpansionApi(query);
      this.logger.log(
        VLM query expansion: "+query+" -> [+variants.map((v) => "+v+").join(', ')+],
      );
      return variants;
    } catch (error) {
      this.logger.warn(
        VLM query expansion failed (non-fatal): +(error instanceof Error ? error.message : 'unknown error'),
      );
      return [];
    }
  }

  private async callExpansionApi(query: string): Promise<string[]> {
    const endpoint = this.buildEndpoint();
    const system =
      'You are a video retrieval query optimizer. ' +
      'Given a search query (possibly in Vietnamese or English), generate ' +
      this.config.vlmQueryExpansionMaxVariants+' alternative English phrasings ' +
      'that would help retrieve the same visual content from a video database. ' +
      'Focus on visual elements: objects, colors, actions, settings, people. ' +
      'Respond ONLY with a JSON array of strings - no markdown, no prose: ["variant1", "variant2", ...]';

    const prompt = 'Original query: "'+query+'"\nGenerate alternative English search variants.';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.vlmApiKey ? { authorization: 'Bearer '+this.config.vlmApiKey } : {}),
      },
      body: JSON.stringify({
        model: this.config.vlmModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_completion_tokens: 256,
      }),
      signal: AbortSignal.timeout(this.config.vlmTimeoutMs),
    });

    if (response.status === 429 || response.status >= 500) {
      this.logger.warn('VLM expansion API returned HTTP '+response.status+', skipping');
      return [];
    }

    if (!response.ok) {
      throw new Error('VLM expansion endpoint returned HTTP '+response.status);
    }

    const payload = await response.json() as {
      choices?: { message?: { content?: unknown } }[];
    };
    const raw = payload.choices?.[0]?.message?.content;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];

    return this.parseVariants(text);
  }

  private buildEndpoint(): string {
    const base = (this.config.vlmBaseUrl ?? '').trim().replace(/\/+$/, '');
    return base.endsWith('/chat/completions') ? base : base+'/chat/completions';
  }

  private parseVariants(text: string): string[] {
    const candidate = text
      .replace(/^+(?:json)?\s*/i, '')
      .replace(/\s*+$/, '')
      .trim();
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, this.config.vlmQueryExpansionMaxVariants);
    } catch {
      return [];
    }
  }
}
