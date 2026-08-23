'use client';

import { useState, type FormEvent } from 'react';

import type { QualificationEventInput, QualificationTask } from '../../lib/contracts';
import type { RrfSettings, RrfWeightKey } from '../../lib/rrf-settings';
import { MAX_NEAR_FRAME_WINDOW_MS, type RetrievalSettings } from '../../lib/retrieval-settings';

interface Props {
  task: QualificationTask;
  displayK: number;
  rrfSettings: RrfSettings;
  rrfError: string | null;
  retrievalSettings: RetrievalSettings;
  retrievalError: string | null;
  description: string;
  question: string;
  events: readonly QualificationEventInput[];
  queryImproverEnabled: boolean;
  queryImproverPending: boolean;
  queryImproverError: string | null;
  pending: boolean;
  onTaskChange: (task: QualificationTask) => void;
  onDescriptionChange: (value: string) => void;
  onQuestionChange: (value: string) => void;
  onEventChange: (eventId: string, value: string) => void;
  onQueryImproverChange: (enabled: boolean) => void;
  onImproveQuery: () => void;
  onQueryImproverSave: () => void;
  onQueryImproverReset: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onExactFrameSearch: (videoId: string, idType: 'original_frame_id' | 'keyframe_no', frameId: number) => void;
  onImportCsv: (file: File) => void;
  exactFramePending: boolean;
  onRrfChange: (settings: RrfSettings) => void;
  onRrfSave: () => void;
  onRrfReset: () => void;
  onRetrievalChange: (settings: RetrievalSettings) => void;
  onRetrievalSave: () => void;
  onRetrievalReset: () => void;
}

const TASKS: ReadonlyArray<{ value: QualificationTask; label: string }> = [
  { value: 'textual_kis', label: 'Textual KIS' },
  { value: 'qa', label: 'Hỏi & Đáp' },
  { value: 'trake', label: 'TRAKE' },
];

const RRF_WEIGHT_FIELDS: ReadonlyArray<{ key: RrfWeightKey; label: string }> = [
  { key: 'visual', label: 'Trọng số visual' },
  { key: 'ocr', label: 'Trọng số OCR' },
  { key: 'asr', label: 'Trọng số ASR' },
  { key: 'caption', label: 'Trọng số caption' },
  { key: 'object', label: 'Trọng số object' },
  { key: 'temporal', label: 'Trọng số temporal' },
  { key: 'audio', label: 'Trọng số audio' },
];

const SAFE_VIDEO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function parseNumberInput(value: string): number {
  return value === '' ? Number.NaN : Number(value);
}

function displayNumberInput(value: number): number | '' {
  return Number.isNaN(value) ? '' : value;
}

export function SearchSidebar({
  task,
  displayK,
  rrfSettings,
  rrfError,
  retrievalSettings,
  retrievalError,
  description,
  question,
  events,
  queryImproverEnabled,
  queryImproverPending,
  queryImproverError,
  pending,
  onTaskChange,
  onDescriptionChange,
  onQuestionChange,
  onEventChange,
  onQueryImproverChange,
  onImproveQuery,
  onQueryImproverSave,
  onQueryImproverReset,
  onSubmit,
  onExactFrameSearch,
  onImportCsv,
  exactFramePending,
  onRrfChange,
  onRrfSave,
  onRrfReset,
  onRetrievalChange,
  onRetrievalSave,
  onRetrievalReset,
}: Props) {
  const [manualVideoId, setManualVideoId] = useState('');
  const [manualIdType, setManualIdType] = useState<'original_frame_id' | 'keyframe_no'>('original_frame_id');
  const [manualFrameId, setManualFrameId] = useState('');
  const vlmRerank = retrievalSettings.vlm_rerank ?? { enabled: false, top_k: 15, weight: 0.6 };
  const hasQuery = task === 'trake'
    ? Boolean(description.trim()) && events.length > 0 && events.every((item) => item.description.trim())
    : description.trim() && (task !== 'qa' || question.trim());
  const descriptionLabel = task === 'trake' ? 'Truy vấn chính' : 'Mô tả sự kiện';
  const parsedManualFrameId = Number(manualFrameId);
  const manualVideoIdValid = SAFE_VIDEO_ID.test(manualVideoId.trim());
  const manualFrameValid = manualFrameId.trim() !== '' && Number.isSafeInteger(parsedManualFrameId)
    && parsedManualFrameId >= (manualIdType === 'keyframe_no' ? 1 : 0);

  function submitExactFrameSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manualVideoIdValid || !manualFrameValid) return;
    onExactFrameSearch(manualVideoId.trim(), manualIdType, parsedManualFrameId);
  }

  return (
    <aside className="search-sidebar" aria-label="Bộ điều khiển tìm kiếm">
      <div className="sidebar-heading">
        <p>AIC 2026 · Sơ tuyển</p>
        <h1>Tìm kiếm video</h1>
      </div>

      <div className="task-switcher" role="tablist" aria-label="Chọn loại bài">
        {TASKS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-label={item.label}
            aria-selected={task === item.value}
            onClick={() => onTaskChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <form className="search-form" onSubmit={onSubmit}>
        <label className="input-field">
          <span>{descriptionLabel}</span>
          <textarea
            aria-label={descriptionLabel}
            value={description}
            maxLength={2000}
            rows={8}
            placeholder={task === 'trake'
              ? 'Mô tả tổng quát toàn bộ chuỗi hành động cần tìm…'
              : 'Mô tả người, hành động, đồ vật, địa điểm hoặc chữ xuất hiện…'}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
        </label>

        {task === 'trake' && (
          <fieldset className="event-editor">
            <legend>Chuỗi sự kiện theo thứ tự</legend>
            {events.map((item, index) => (
              <div className="event-input" key={item.event_id}>
                <label>
                  <span>Sự kiện {index + 1}</span>
                  <textarea
                    aria-label={`Mô tả sự kiện ${index + 1}`}
                    value={item.description}
                    maxLength={1000}
                    rows={3}
                    placeholder="Mô tả khoảnh khắc cần tìm…"
                    onChange={(event) => onEventChange(item.event_id, event.target.value)}
                  />
                </label>
              </div>
            ))}
          </fieldset>
        )}

        {task === 'qa' && (
          <label className="input-field compact-field">
            <span>Câu hỏi</span>
            <input
              aria-label="Câu hỏi"
              value={question}
              maxLength={2000}
              placeholder="Thông tin cần trả lời là gì?"
              onChange={(event) => onQuestionChange(event.target.value)}
            />
          </label>
        )}

        <div className="search-options">
          <span>Top {displayK} frame</span>
          <span>Ảnh trước, video sau</span>
        </div>
        <button type="submit" className="primary-button full-width" disabled={pending || !hasQuery}>
          {pending ? 'Đang tìm…' : 'Tìm frame'}
        </button>
      </form>

      <section className="sidebar-panel exact-frame-panel" aria-labelledby="exact-frame-title">
        <div className="sidebar-panel-heading">
          <div>
            <p className="section-kicker">Tra cứu trực tiếp</p>
            <h2 id="exact-frame-title">Nạp frame theo ID</h2>
          </div>
          <span className="sidebar-panel-badge">Exact</span>
        </div>

        <form className="exact-frame-form" onSubmit={submitExactFrameSearch}>
          <label className="input-field compact-field">
            <span>Video ID</span>
            <input
              aria-label="Video ID"
              value={manualVideoId}
              maxLength={200}
              placeholder="video_01"
              onChange={(event) => setManualVideoId(event.target.value)}
            />
          </label>
          <label className="input-field compact-field">
            <span>Loại ID frame</span>
            <select
              aria-label="Loại ID frame"
              value={manualIdType}
              onChange={(event) => setManualIdType(event.target.value as 'original_frame_id' | 'keyframe_no')}
            >
              <option value="original_frame_id">Frame ID gốc</option>
              <option value="keyframe_no">Keyframe ordinal</option>
            </select>
          </label>
          <label className="input-field compact-field">
            <span>ID frame</span>
            <input
              aria-label="ID frame"
              type="number"
              min={manualIdType === 'keyframe_no' ? 1 : 0}
              step="1"
              value={manualFrameId}
              placeholder="385"
              onChange={(event) => setManualFrameId(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="secondary-button full-width"
            disabled={exactFramePending || !manualVideoIdValid || !manualFrameValid}
          >
            {exactFramePending ? 'Đang nạp frame…' : 'Tra cứu frame'}
          </button>
        </form>
        <label className="file-input-field">
          <span>Khôi phục đáp án từ CSV hiện tại</span>
          <input
            aria-label="Import CSV đáp án"
            type="file"
            accept=".csv,text/csv"
            disabled={exactFramePending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (file) onImportCsv(file);
            }}
          />
        </label>
        <p className="sidebar-help">
          Có thể nhập frame ID gốc hoặc thứ tự keyframe; CSV sẽ nạp lại frame và hàng đợi đáp án theo task hiện tại.
        </p>
      </section>

      <section className="sidebar-panel query-improver-panel" aria-labelledby="query-improver-title">
        <div className="sidebar-panel-heading">
          <div>
            <p className="section-kicker">Chuẩn hóa truy vấn</p>
            <h2 id="query-improver-title">Query Improver</h2>
          </div>
          <span className="sidebar-panel-badge">{task === 'qa' ? 'query + question' : task === 'trake' ? `query + ${events.length} event` : '1 query'}</span>
        </div>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={queryImproverEnabled}
            onChange={(event) => onQueryImproverChange(event.target.checked)}
          />
          <span>Bật Query Improver</span>
        </label>

        {queryImproverEnabled && (
          <>
            <button
              type="button"
              className="secondary-button full-width"
              disabled={queryImproverPending || !hasQuery}
              onClick={onImproveQuery}
            >
              {queryImproverPending
                ? 'Đang cải thiện…'
                : task === 'qa' ? 'Cải thiện query & câu hỏi' : task === 'trake' ? 'Cải thiện query & các event' : 'Cải thiện query'}
            </button>
            <p className="sidebar-help">
              Kết quả cải thiện sẽ được ghi trực tiếp vào ô nhập chính trước khi tìm.
            </p>
            {queryImproverError && <p className="settings-error" role="alert">{queryImproverError}</p>}
            <div className="sidebar-panel-actions">
              <button type="button" className="secondary-button" onClick={onQueryImproverReset}>Tắt mặc định</button>
              <button type="button" className="primary-button" onClick={onQueryImproverSave}>Lưu Query Improver</button>
            </div>
          </>
        )}
      </section>

      <section className="sidebar-panel rrf-panel" aria-labelledby="rrf-settings-title">
        <div className="sidebar-panel-heading">
          <div>
            <p className="section-kicker">Xếp hạng kết quả</p>
            <h2 id="rrf-settings-title">RRF fusion</h2>
          </div>
          <span className="sidebar-panel-badge">K={displayNumberInput(rrfSettings.rrf_k) || '—'}</span>
        </div>

        <label htmlFor="rrf-k">
          <span>RRF K</span>
          <input
            id="rrf-k"
            aria-label="RRF K"
            type="number"
            min="1"
            max="1000"
            step="1"
            value={displayNumberInput(rrfSettings.rrf_k)}
            onChange={(event) => onRrfChange({ ...rrfSettings, rrf_k: parseNumberInput(event.target.value) })}
          />
        </label>

        <div className="rrf-weight-grid">
          {RRF_WEIGHT_FIELDS.map((field) => (
            <label key={field.key} htmlFor={`rrf-weight-${field.key}`}>
              <span>{field.label}</span>
              <input
                id={`rrf-weight-${field.key}`}
                aria-label={field.label}
                type="number"
                min="0"
                max="5"
                step="0.05"
                inputMode="decimal"
                value={displayNumberInput(rrfSettings.weights[field.key])}
                onChange={(event) => onRrfChange({
                  ...rrfSettings,
                  weights: { ...rrfSettings.weights, [field.key]: parseNumberInput(event.target.value) },
                })}
              />
            </label>
          ))}
        </div>

        {rrfError && <p className="settings-error" role="alert">{rrfError}</p>}
        <p className="sidebar-help">
          K càng lớn càng giảm ảnh hưởng của thứ hạng; trọng số cao sẽ ưu tiên modality tương ứng.
        </p>
        <div className="sidebar-panel-actions">
          <button type="button" className="secondary-button" onClick={onRrfReset}>Khôi phục RRF</button>
          <button type="button" className="primary-button" onClick={onRrfSave}>Lưu cấu hình RRF</button>
        </div>
      </section>

      <section className="sidebar-panel retrieval-panel" aria-labelledby="retrieval-settings-title">
        <div className="sidebar-panel-heading">
          <div>
            <p className="section-kicker">Phạm vi truy hồi</p>
            <h2 id="retrieval-settings-title">Số lượng kết quả</h2>
          </div>
          <span className="sidebar-panel-badge">Top {displayNumberInput(retrievalSettings.display_k) || '—'}</span>
        </div>

        <label htmlFor="retrieval-display-k-sidebar">
          <span>Số frame hiển thị</span>
          <input
            id="retrieval-display-k-sidebar"
            aria-label="Số frame hiển thị"
            type="number"
            min="1"
            max="100"
            step="1"
            value={displayNumberInput(retrievalSettings.display_k)}
            onChange={(event) => onRetrievalChange({
              ...retrievalSettings,
              display_k: parseNumberInput(event.target.value),
            })}
          />
        </label>

        <div className="retrieval-settings-grid">
          <label htmlFor="retrieval-branch-k-sidebar">
            <span>Candidate mỗi modality</span>
            <input
              id="retrieval-branch-k-sidebar"
              aria-label="Candidate mỗi modality"
              type="number"
              min="1"
              max="10000"
              step="1"
              value={displayNumberInput(retrievalSettings.branch_k)}
              onChange={(event) => onRetrievalChange({
                ...retrievalSettings,
                branch_k: parseNumberInput(event.target.value),
              })}
            />
          </label>
          <label htmlFor="retrieval-fusion-k-sidebar">
            <span>Fusion candidate pool</span>
            <input
              id="retrieval-fusion-k-sidebar"
              aria-label="Fusion candidate pool"
              type="number"
              min="1"
              max="10000"
              step="1"
              value={displayNumberInput(retrievalSettings.fusion_k)}
              onChange={(event) => onRetrievalChange({
                ...retrievalSettings,
                fusion_k: parseNumberInput(event.target.value),
              })}
            />
          </label>
        </div>

        <label htmlFor="retrieval-near-window-sidebar">
          <span>Lọc frame gần nhau (ms)</span>
          <input
            id="retrieval-near-window-sidebar"
            aria-label="Lọc frame gần nhau (ms)"
            type="number"
            min="0"
            max={MAX_NEAR_FRAME_WINDOW_MS}
            step="100"
            value={displayNumberInput(retrievalSettings.near_frame_window_ms ?? 1000)}
            onChange={(event) => onRetrievalChange({
              ...retrievalSettings,
              near_frame_window_ms: parseNumberInput(event.target.value),
            })}
          />
        </label>

        <label className="settings-toggle">
          <input
            id="vlm-rerank-enabled-sidebar"
            type="checkbox"
            checked={vlmRerank.enabled}
            onChange={(event) => onRetrievalChange({
              ...retrievalSettings,
              vlm_rerank: { ...vlmRerank, enabled: event.target.checked },
            })}
          />
          <span>Bật VLM rerank top-k (Gemini / Qwen)</span>
        </label>
        <div className="retrieval-settings-grid">
          <label htmlFor="retrieval-vlm-top-k">
            <span>VLM top-k</span>
            <input
              id="retrieval-vlm-top-k"
              aria-label="VLM top-k"
              type="number"
              min="1"
              max="100"
              step="1"
              value={displayNumberInput(vlmRerank.top_k)}
              onChange={(event) => onRetrievalChange({
                ...retrievalSettings,
                vlm_rerank: { ...vlmRerank, top_k: parseNumberInput(event.target.value) },
              })}
            />
          </label>
          <label htmlFor="retrieval-vlm-weight">
            <span>VLM weight</span>
            <input
              id="retrieval-vlm-weight"
              aria-label="VLM weight"
              type="number"
              min="0"
              max="1"
              step="0.05"
              inputMode="decimal"
              value={displayNumberInput(vlmRerank.weight)}
              onChange={(event) => onRetrievalChange({
                ...retrievalSettings,
                vlm_rerank: { ...vlmRerank, weight: parseNumberInput(event.target.value) },
              })}
            />
          </label>
          <label htmlFor="retrieval-vlm-min-score">
            <span>VLM min score (0 = tắt)</span>
            <input
              id="retrieval-vlm-min-score"
              aria-label="VLM min score"
              type="number"
              min="0"
              max="100"
              step="5"
              value={displayNumberInput(vlmRerank.vlm_min_score ?? 0)}
              onChange={(event) => onRetrievalChange({
                ...retrievalSettings,
                vlm_rerank: { ...vlmRerank, vlm_min_score: parseNumberInput(event.target.value) },
              })}
            />
          </label>
        </div>

        {retrievalError && <p className="settings-error" role="alert">{retrievalError}</p>}
        <p className="sidebar-help">
          Frame cùng video trong cửa sổ này sẽ được gộp và giữ frame điểm cao nhất. Nhập 0 để tắt. VLM rerank gửi ảnh của top-k lên model nên chỉ bật khi backend đã cấu hình VLM.
        </p>
        <div className="sidebar-panel-actions">
          <button type="button" className="secondary-button" onClick={onRetrievalReset}>Khôi phục truy hồi mặc định</button>
          <button type="button" className="primary-button" onClick={onRetrievalSave}>Lưu cài đặt truy hồi</button>
        </div>
      </section>
    </aside>
  );
}
