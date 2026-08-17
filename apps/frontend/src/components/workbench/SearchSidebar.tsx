'use client';

import type { FormEvent } from 'react';

import type { QualificationEventInput, QualificationTask } from '../../lib/contracts';

interface Props {
  task: QualificationTask;
  displayK: number;
  description: string;
  question: string;
  events: readonly QualificationEventInput[];
  pending: boolean;
  onTaskChange: (task: QualificationTask) => void;
  onDescriptionChange: (value: string) => void;
  onQuestionChange: (value: string) => void;
  onEventChange: (eventId: string, value: string) => void;
  onAddEvent: () => void;
  onRemoveEvent: (eventId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const TASKS: ReadonlyArray<{ value: QualificationTask; label: string }> = [
  { value: 'textual_kis', label: 'Textual KIS' },
  { value: 'qa', label: 'Hỏi & Đáp' },
  { value: 'trake', label: 'TRAKE' },
];

export function SearchSidebar({
  task,
  displayK,
  description,
  question,
  events,
  pending,
  onTaskChange,
  onDescriptionChange,
  onQuestionChange,
  onEventChange,
  onAddEvent,
  onRemoveEvent,
  onSubmit,
}: Props) {
  const hasQuery = task === 'trake'
    ? events.length > 0 && events.every((item) => item.description.trim())
    : description.trim() && (task !== 'qa' || question.trim());

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
        {task !== 'trake' ? (
          <label className="input-field">
            <span>Mô tả sự kiện</span>
            <textarea
              aria-label="Mô tả sự kiện"
              value={description}
              maxLength={2000}
              rows={8}
              placeholder="Mô tả người, hành động, đồ vật, địa điểm hoặc chữ xuất hiện…"
              onChange={(event) => onDescriptionChange(event.target.value)}
            />
          </label>
        ) : (
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
                {events.length > 1 && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Xóa sự kiện ${index + 1}`}
                    onClick={() => onRemoveEvent(item.event_id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="secondary-button full-width" aria-label="Thêm sự kiện" onClick={onAddEvent}>
              + Thêm sự kiện
            </button>
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
    </aside>
  );
}
