'use client';

import { useEffect, useRef } from 'react';

import type { EmbeddingSettings } from '../../lib/embedding-settings';
import type { LlmSettings } from '../../lib/llm-settings';

interface Props {
  settings: LlmSettings;
  error: string | null;
  onChange: (settings: LlmSettings) => void;
  onSave: () => void;
  onReset: () => void;
  embeddingSettings: EmbeddingSettings;
  embeddingError: string | null;
  onEmbeddingChange: (settings: EmbeddingSettings) => void;
  onEmbeddingSave: () => void;
  onEmbeddingReset: () => void;
  onClose: () => void;
}

export function LlmSettingsPopover({
  settings,
  error,
  onChange,
  onSave,
  onReset,
  embeddingSettings,
  embeddingError,
  onEmbeddingChange,
  onEmbeddingSave,
  onEmbeddingReset,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  function update<K extends keyof LlmSettings>(key: K, value: LlmSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function updateEmbedding<K extends keyof EmbeddingSettings>(key: K, value: EmbeddingSettings[K]) {
    onEmbeddingChange({ ...embeddingSettings, [key]: value });
  }

  return (
    <section id="llm-settings" ref={panelRef} className="settings-popover" role="dialog" aria-label="Cài đặt LLM">
      <header className="settings-heading">
        <div>
          <p className="section-kicker">Cấu hình theo phiên frontend</p>
          <h2>Cài đặt LLM</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Đóng cài đặt" onClick={onClose}>×</button>
      </header>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => update('enabled', event.target.checked)}
        />
        <span>Bật cấu hình LLM từ frontend</span>
      </label>
      <p className="settings-help">Tắt để dùng cấu hình LLM trong `.env` của backend.</p>

      <label htmlFor="llm-base-url">
        <span>Endpoint LLM</span>
        <input
          id="llm-base-url"
          type="url"
          value={settings.base_url}
          placeholder="https://provider.example/v1"
          onChange={(event) => update('base_url', event.target.value)}
        />
      </label>
      <label htmlFor="llm-api-key">
        <span>API key LLM</span>
        <input
          id="llm-api-key"
          type="password"
          value={settings.api_key}
          autoComplete="off"
          placeholder="Để trống nếu endpoint không cần key"
          onChange={(event) => update('api_key', event.target.value)}
        />
      </label>
      <label htmlFor="llm-model">
        <span>Model LLM</span>
        <input
          id="llm-model"
          type="text"
          value={settings.model}
          placeholder="model-name"
          onChange={(event) => update('model', event.target.value)}
        />
      </label>

      <div className="settings-grid">
        <label htmlFor="llm-timeout">
          <span>Timeout (ms)</span>
          <input
            id="llm-timeout"
            type="number"
            min={100}
            max={120000}
            step={100}
            value={settings.timeout_ms}
            onChange={(event) => update('timeout_ms', Number(event.target.value))}
          />
        </label>
        <label htmlFor="llm-max-tokens">
          <span>Max tokens</span>
          <input
            id="llm-max-tokens"
            type="number"
            min={1}
            max={4096}
            step={1}
            value={settings.max_tokens}
            onChange={(event) => update('max_tokens', Number(event.target.value))}
          />
        </label>
      </div>
      <label htmlFor="llm-temperature">
        <span>Temperature</span>
        <input
          id="llm-temperature"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={settings.temperature}
          onChange={(event) => update('temperature', Number(event.target.value))}
        />
      </label>

      {error && <p className="settings-error" role="alert">{error}</p>}
      <p className="settings-help">API key chỉ giữ trong bộ nhớ của tab hiện tại và không được lưu vào localStorage.</p>
      <div className="settings-actions">
        <button type="button" className="quiet-button" onClick={onReset}>Khôi phục mặc định</button>
        <button type="button" className="primary-button" onClick={onSave}>Lưu cài đặt LLM</button>
      </div>

      <div className="settings-divider" />
      <div aria-labelledby="embedding-settings-title">
        <p className="section-kicker">Truy hồi CLIPA độc lập với branch context</p>
        <h3 id="embedding-settings-title">Cài đặt embedding</h3>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={embeddingSettings.enabled}
            onChange={(event) => updateEmbedding('enabled', event.target.checked)}
          />
          <span>Bật cấu hình embedding từ frontend</span>
        </label>
        <p className="settings-help">URL này chỉ chọn service embed query cho phiên hiện tại; số chiều cố định là 1024.</p>

        <label htmlFor="embedding-base-url">
          <span>Embedding service URL</span>
          <input
            id="embedding-base-url"
            type="url"
            value={embeddingSettings.base_url}
            placeholder="http://127.0.0.1:8001/embed"
            onChange={(event) => updateEmbedding('base_url', event.target.value)}
          />
        </label>
        <label htmlFor="embedding-api-key">
          <span>API token embedding</span>
          <input
            id="embedding-api-key"
            type="password"
            value={embeddingSettings.api_key}
            autoComplete="off"
            placeholder="Để trống nếu service không cần token"
            onChange={(event) => updateEmbedding('api_key', event.target.value)}
          />
        </label>
        <label htmlFor="embedding-timeout">
          <span>Timeout embedding (ms)</span>
          <input
            id="embedding-timeout"
            type="number"
            min={100}
            max={120000}
            step={100}
            value={embeddingSettings.timeout_ms}
            onChange={(event) => updateEmbedding('timeout_ms', Number(event.target.value))}
          />
        </label>

        {embeddingError && <p className="settings-error" role="alert">{embeddingError}</p>}
        <p className="settings-help">Token embedding chỉ giữ trong bộ nhớ tab hiện tại và không lưu vào localStorage.</p>
        <div className="settings-actions">
          <button type="button" className="quiet-button" onClick={onEmbeddingReset}>Khôi phục embedding mặc định</button>
          <button type="button" className="primary-button" onClick={onEmbeddingSave}>Lưu cài đặt embedding</button>
        </div>
      </div>
    </section>
  );
}
