import type { SearchRetrievalConfig } from './contracts';

export interface RetrievalSettings extends SearchRetrievalConfig {}

export const DEFAULT_RETRIEVAL_SETTINGS: RetrievalSettings = {
  display_k: 20,
  branch_k: 100,
  fusion_k: 500,
  vlm_rerank: {
    enabled: false,
    top_k: 20,
    weight: 0.7,
    vlm_min_score: 0,
  },
};

const STORAGE_KEY = 'aic.retrieval.settings';

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function loadRetrievalSettings(): RetrievalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_RETRIEVAL_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_RETRIEVAL_SETTINGS };
    }
    const value = parsed as Record<string, unknown>;
    const vlmRaw = value.vlm_rerank as Record<string, unknown> | undefined;
    return {
      display_k: numberValue(value.display_k, DEFAULT_RETRIEVAL_SETTINGS.display_k),
      branch_k: numberValue(value.branch_k, DEFAULT_RETRIEVAL_SETTINGS.branch_k),
      fusion_k: numberValue(value.fusion_k, DEFAULT_RETRIEVAL_SETTINGS.fusion_k),
      vlm_rerank: {
        enabled: typeof vlmRaw?.enabled === 'boolean' ? vlmRaw.enabled : DEFAULT_RETRIEVAL_SETTINGS.vlm_rerank?.enabled ?? false,
        top_k: numberValue(vlmRaw?.top_k, DEFAULT_RETRIEVAL_SETTINGS.vlm_rerank?.top_k ?? 20),
        weight: numberValue(vlmRaw?.weight, DEFAULT_RETRIEVAL_SETTINGS.vlm_rerank?.weight ?? 0.7),
        vlm_min_score: numberValue(vlmRaw?.vlm_min_score, DEFAULT_RETRIEVAL_SETTINGS.vlm_rerank?.vlm_min_score ?? 0),
      },
    };
  } catch {
    return { ...DEFAULT_RETRIEVAL_SETTINGS };
  }
}

export function saveRetrievalSettings(settings: RetrievalSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function validateRetrievalSettings(settings: RetrievalSettings): string | null {
  if (!Number.isSafeInteger(settings.display_k) || settings.display_k < 1 || settings.display_k > 100) {
    return 'Số frame hiển thị phải nằm trong khoảng 1–100.';
  }
  if (!Number.isSafeInteger(settings.branch_k) || settings.branch_k < 1 || settings.branch_k > 10_000) {
    return 'Candidate mỗi modality phải nằm trong khoảng 1–10000.';
  }
  if (!Number.isSafeInteger(settings.fusion_k) || settings.fusion_k < 1 || settings.fusion_k > 10_000) {
    return 'Fusion candidate pool phải nằm trong khoảng 1–10000.';
  }
  if (settings.fusion_k < settings.display_k) {
    return 'Fusion candidate pool phải lớn hơn hoặc bằng số frame hiển thị.';
  }
  return null;
}

export function buildSearchRetrievalConfig(settings: RetrievalSettings): SearchRetrievalConfig {
  return {
    display_k: settings.display_k,
    branch_k: settings.branch_k,
    fusion_k: settings.fusion_k,
    ...(settings.vlm_rerank?.enabled ? { vlm_rerank: settings.vlm_rerank } : {}),
  };
}
