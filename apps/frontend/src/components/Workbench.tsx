'use client';

import { FormEvent, KeyboardEvent, useMemo, useState } from 'react';

import type { SearchRequest, SearchResponse, SearchResult, Task } from '../lib/contracts';

interface Props {
  search: (request: SearchRequest) => Promise<SearchResponse>;
}

const TASKS: readonly Task[] = ['textual_kis', 'video_kis', 'avs', 'vqa', 'kisc'];

export function Workbench({ search }: Props) {
  const [query, setQuery] = useState('');
  const [task, setTask] = useState<Task>('textual_kis');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const selected = useMemo(
    () => response?.results.find((result) => result.segment_id === selectedId) ?? null,
    [response, selectedId],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanQuery = query.trim();
    if (!cleanQuery || loading) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    setSelectedId(null);
    try {
      const next = await search({ query: cleanQuery, task, top_k: task === 'avs' ? 50 : 20 });
      setResponse(next);
      setSelectedId(next.results[0]?.segment_id ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  function handleResultKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!response || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, response.results.findIndex((item) => item.segment_id === selectedId));
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = response.results[Math.min(response.results.length - 1, Math.max(0, current + delta))];
    setSelectedId(next?.segment_id ?? null);
  }

  return (
    <main className="workbench">
      <header>
        <p className="eyebrow">AIC HCMC 2026</p>
        <h1>Multimodal Evidence Workbench</h1>
      </header>
      <form className="query" onSubmit={submit}>
        <label>
          <span>Search multimedia</span>
          <input value={query} maxLength={2000} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label>
          <span>Task</span>
          <select value={task} onChange={(event) => setTask(event.target.value as Task)}>
            {TASKS.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <button disabled={loading || !query.trim()}>{loading ? 'Searching…' : 'Search'}</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {response?.degraded && (
        <p role="status" className="warning">
          Partial results: {response.unavailable_branches.map((value) => value.toUpperCase()).join(', ')} unavailable.
        </p>
      )}
      <section className="content">
        <div className="results" aria-label="Search results" onKeyDown={handleResultKeys}>
          {response?.results.map((result) => (
            <ResultCard
              key={result.segment_id}
              result={result}
              selected={result.segment_id === selectedId}
              onSelect={() => setSelectedId(result.segment_id)}
            />
          ))}
          {response && response.results.length === 0 && <p>No evidence found. Refine the query.</p>}
        </div>
        <EvidencePanel result={selected} />
      </section>
    </main>
  );
}

function ResultCard({ result, selected, onSelect }: {
  result: SearchResult;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <strong>{result.video_id}</strong>
      <span>{result.start_ms}–{result.end_ms} ms</span>
      <small>{result.matched_modalities.join(' · ')} · score {result.score.toFixed(3)}</small>
    </button>
  );
}

function EvidencePanel({ result }: { result: SearchResult | null }) {
  if (!result) return <aside className="inspector"><p>Select a result to inspect evidence.</p></aside>;
  return (
    <aside className="inspector">
      <h2>{result.video_id}</h2>
      <p>{result.start_ms}–{result.end_ms} ms</p>
      <video controls preload="metadata" src={`${result.preview_uri}#t=${result.start_ms / 1000},${result.end_ms / 1000}`} />
      <h3>Evidence</h3>
      {result.evidence_ids.map((evidenceId) => (
        <article key={evidenceId} className="evidence">
          <b>Evidence</b>
          <span>{evidenceId}</span>
        </article>
      ))}
      <button type="button" disabled title="Organizer adapter is disabled">Preview submission</button>
    </aside>
  );
}
