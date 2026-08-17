import type { SearchRetrievalConfig, SearchRrfBranch } from './contracts';

export const RRF_WEIGHT_KEYS = ['visual', 'ocr', 'asr', 'caption', 'object', 'temporal', 'audio'] as const;
export type RrfWeightKey = (typeof RRF_WEIGHT_KEYS)[number];

export interface RrfSettings {
  rrf_k: number;
  weights: Record<RrfWeightKey, number>;
}

export const DEFAULT_RRF_SETTINGS: RrfSettings = {
  rrf_k: 60,
  weights: {
    visual: 1,
    ocr: 1.25,
    asr: 1.25,
    caption: 1,
    object: 1.2,
    temporal: 1,
    audio: 1,
  },
};

const STORAGE_KEY = 'aic.rrf.settings';

function defaultSettings(): RrfSettings {
  return {
    rrf_k: DEFAULT_RRF_SETTINGS.rrf_k,
    weights: { ...DEFAULT_RRF_SETTINGS.weights },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function loadRrfSettings(): RrfSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.weights)) return defaultSettings();
    const rawWeights = parsed.weights;

    const weights = RRF_WEIGHT_KEYS.reduce<Record<RrfWeightKey, number>>((result, key) => ({
      ...result,
      [key]: numberValue(rawWeights[key], DEFAULT_RRF_SETTINGS.weights[key]),
    }), { ...DEFAULT_RRF_SETTINGS.weights });
    return {
      rrf_k: numberValue(parsed.rrf_k, DEFAULT_RRF_SETTINGS.rrf_k),
      weights,
    };
  } catch {
    return defaultSettings();
  }
}

export function saveRrfSettings(settings: RrfSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function validateRrfSettings(settings: RrfSettings): string | null {
  if (!Number.isSafeInteger(settings.rrf_k) || settings.rrf_k < 1 || settings.rrf_k > 1000) {
    return 'RRF K phải là số nguyên trong khoảng 1–1000.';
  }

  for (const key of RRF_WEIGHT_KEYS) {
    const weight = settings.weights[key];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 5) {
      return `RRF: trọng số ${key} phải nằm trong khoảng 0–5.`;
    }
  }

  if (RRF_WEIGHT_KEYS.every((key) => settings.weights[key] === 0)) {
    return 'RRF cần ít nhất một modality có trọng số lớn hơn 0.';
  }
  return null;
}

export function buildSearchRrfConfig(
  settings: RrfSettings,
): Pick<SearchRetrievalConfig, 'rrf_k' | 'channel_weights'> {
  const weights: Partial<Record<SearchRrfBranch, number>> = {
    visual: settings.weights.visual,
    clip: settings.weights.visual,
    ocr_lexical: settings.weights.ocr,
    ocr_semantic: settings.weights.ocr,
    asr_lexical: settings.weights.asr,
    asr_semantic: settings.weights.asr,
    caption: settings.weights.caption,
    object: settings.weights.object,
    temporal: settings.weights.temporal,
    audio: settings.weights.audio,
  };
  return {
    rrf_k: settings.rrf_k,
    channel_weights: weights,
  };
}
