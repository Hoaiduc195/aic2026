'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';

type Task = 'textual_kis' | 'vqa' | 'trake';
type Profile = 'fast' | 'balanced' | 'accurate';
type ScanMode = 'sparse' | 'temporal_zoom' | 'dense';
interface Run { run_id: string; status: string; query?: string; scan_mode?: ScanMode; videos_total?: number; videos_examined?: number; frames_total?: number; frames_examined?: number; judgment_count?: number }
interface ApiResponse { run?: Run; message?: string }

function response(value: unknown): ApiResponse | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiResponse : null;
}

export function AgentPanel() {
  const [query, setQuery] = useState('');
  const [task, setTask] = useState<Task>('textual_kis');
  const [profile, setProfile] = useState<Profile>('fast');
  const [scanMode, setScanMode] = useState<ScanMode>('temporal_zoom');
  const [topK, setTopK] = useState(30);
  const [videoBudget, setVideoBudget] = useState(3);
  const [batchSize, setBatchSize] = useState(16);
  const [windowSeconds, setWindowSeconds] = useState(20);
  const [mergeGapSeconds, setMergeGapSeconds] = useState(15);
  const [windowsPerVideo, setWindowsPerVideo] = useState(2);
  const [sampleFps, setSampleFps] = useState(1);
  const [finalRadiusSeconds, setFinalRadiusSeconds] = useState(2);
  const [stopScore, setStopScore] = useState(0.82);
  const [deadlineSeconds, setDeadlineSeconds] = useState(300);
  const [prefilterRatio, setPrefilterRatio] = useState(0.05);
  const [vlmRatio, setVlmRatio] = useState(0.005);
  const [maxBatches, setMaxBatches] = useState(0);
  const [workerId, setWorkerId] = useState('worker-ui-1');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [pilot, setPilot] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const command = useMemo(() => run ? [
    '.\\scripts\\run_agent.ps1', `-RunId '${run.run_id}'`, `-WorkerId '${workerId}'`,
    `-Profile ${profile}`, `-TemporalFinalRadiusSeconds ${finalRadiusSeconds}`,
    `-TemporalStopScore ${stopScore}`, `-TemporalDeadlineSeconds ${deadlineSeconds}`,
    `-PrefilterCandidateRatio ${prefilterRatio}`, `-VlmCandidateRatio ${vlmRatio}`,
    ...(model.trim() ? [`-Model '${model.trim()}'`] : []),
    ...(baseUrl.trim() ? [`-BaseUrl '${baseUrl.trim()}'`] : []),
    ...(maxBatches > 0 ? [`-MaxBatches ${maxBatches}`] : []), ...(pilot ? ['-Pilot'] : []), '-Yes',
  ].join(' ') : '', [baseUrl, deadlineSeconds, finalRadiusSeconds, maxBatches, model, pilot,
    prefilterRatio, profile, run, stopScore, vlmRatio, workerId]);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const timer = window.setInterval(() => { void refresh(run.run_id, true); }, 3000);
    return () => window.clearInterval(timer);
  }, [run]);

  function applyProfile(next: Profile) {
    setProfile(next); setScanMode('temporal_zoom'); setBatchSize(16); setPilot(false); setMaxBatches(0);
    if (next === 'fast') {
      setTopK(30); setVideoBudget(3); setWindowSeconds(20); setMergeGapSeconds(15); setWindowsPerVideo(2);
      setSampleFps(1); setFinalRadiusSeconds(2); setStopScore(0.82); setDeadlineSeconds(300);
    } else if (next === 'balanced') {
      setTopK(50); setVideoBudget(5); setWindowSeconds(30); setMergeGapSeconds(15); setWindowsPerVideo(3);
      setSampleFps(2); setFinalRadiusSeconds(2); setStopScore(0.78); setDeadlineSeconds(420);
    } else {
      setBatchSize(4);
      setTopK(100); setVideoBudget(10); setWindowSeconds(45); setMergeGapSeconds(20); setWindowsPerVideo(4);
      setSampleFps(2); setFinalRadiusSeconds(3); setStopScore(0.88); setDeadlineSeconds(600);
    }
  }

  async function refresh(id: string, silent = false) {
    try {
      const result = await fetch(`/api/v1/agent/frame-search/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const payload = response(await result.json().catch(() => null));
      if (!result.ok) throw new Error(payload?.message ?? 'Không tải được trạng thái run.');
      if (payload?.run) setRun(payload.run);
      if (!silent) setNotice('Đã cập nhật trạng thái agent.');
    } catch (reason) { if (!silent) setError(reason instanceof Error ? reason.message : 'Không tải được trạng thái run.'); }
  }

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) { setError('Hãy nhập query cho agent.'); return; }
    setBusy(true); setError(null); setNotice(null); setRun(null);
    try {
      const result = await fetch('/api/v1/agent/frame-search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(), task, top_k: topK, video_budget: videoBudget,
          frame_batch_size: batchSize, scan_mode: scanMode,
          temporal_window_seconds: windowSeconds, temporal_merge_gap_seconds: mergeGapSeconds,
          temporal_windows_per_video: windowsPerVideo, temporal_sample_fps: sampleFps,
        }),
      });
      const payload = response(await result.json().catch(() => null));
      if (!result.ok) throw new Error(payload?.message ?? `Backend trả HTTP ${result.status}.`);
      if (!payload?.run?.run_id) throw new Error('Backend không trả về run_id.');
      setRun(payload.run); setNotice('Đã tạo run. Copy lệnh bên dưới vào PowerShell để khởi động worker.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thể tạo agent run.'); }
    finally { setBusy(false); }
  }

  async function stopRun() {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const result = await fetch(`/api/v1/agent/frame-search/${encodeURIComponent(run.run_id)}/stop`, { method: 'POST' });
      const payload = response(await result.json().catch(() => null));
      if (!result.ok) throw new Error(payload?.message ?? 'Không thể dừng run.');
      await refresh(run.run_id, true); setNotice('Đã dừng run.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thể dừng run.'); }
    finally { setBusy(false); }
  }

  async function copyCommand() {
    try { await navigator.clipboard.writeText(command); setNotice('Đã copy lệnh worker.'); }
    catch { setError('Không thể copy tự động; hãy bôi đen và copy lệnh.'); }
  }

  const numberInput = (value: number, setter: (value: number) => void, min: number, max: number, step?: number) =>
    <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => setter(Number(event.target.value))} />;

  return <section className="agent-panel" aria-labelledby="agent-panel-title">
    <div className="agent-panel-heading"><div><p className="section-kicker">Agent verification worker</p>
      <h2 id="agent-panel-title">Tìm frame bằng Temporal Zoom Agent</h2>
      <p>Retrieval chọn video và mốc thời gian; Luna xem storyboard rồi worker chỉ soi frame raw quanh vùng tốt nhất.</p>
    </div>{run && <span className={`agent-status agent-status-${run.status}`}>{run.status}</span>}</div>

    <form className="agent-form" onSubmit={createRun}>
      <label className="agent-query-field"><span>Query</span><textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} maxLength={2000} placeholder="Ví dụ: một người đóng nắp bình xăng xe máy" /></label>
      <div className="agent-controls">
        <label><span>Task</span><select value={task} onChange={(event) => setTask(event.target.value as Task)}><option value="textual_kis">Textual KIS</option><option value="vqa">VQA</option><option value="trake">TRAKE</option></select></label>
        <label><span>Profile</span><select value={profile} onChange={(event) => applyProfile(event.target.value as Profile)}><option value="fast">Competition Fast</option><option value="balanced">Balanced fallback</option><option value="accurate">Accurate</option></select></label>
        <label><span>Chế độ quét</span><select value={scanMode} onChange={(event) => setScanMode(event.target.value as ScanMode)}><option value="temporal_zoom">Temporal Zoom — khuyên dùng</option><option value="sparse">Sparse — chỉ keyframe</option><option value="dense">Dense — mọi frame raw</option></select></label>
        <label><span>Top-k retrieval</span>{numberInput(topK, setTopK, 1, 100)}</label>
        <label><span>Video budget</span>{numberInput(videoBudget, setVideoBudget, 1, 50)}</label>
        <label><span>Frame/storyboard</span>{numberInput(batchSize, setBatchSize, 1, scanMode === 'temporal_zoom' ? 16 : 512)}<small>Temporal Zoom nên để 16</small></label>
        {scanMode === 'temporal_zoom' && <>
          <label><span>Bán kính cửa sổ (giây)</span>{numberInput(windowSeconds, setWindowSeconds, 5, 120)}</label>
          <label><span>Khoảng gộp (giây)</span>{numberInput(mergeGapSeconds, setMergeGapSeconds, 0, 120)}</label>
          <label><span>Cửa sổ/video</span>{numberInput(windowsPerVideo, setWindowsPerVideo, 1, 10)}</label>
          <label><span>Lấy mẫu thô (FPS)</span>{numberInput(sampleFps, setSampleFps, 1, 5)}</label>
          <label><span>Zoom cuối ± giây</span>{numberInput(finalRadiusSeconds, setFinalRadiusSeconds, 0.5, 10, 0.5)}</label>
          <label><span>Dừng sớm khi điểm ≥</span>{numberInput(stopScore, setStopScore, 0.5, 1, 0.01)}</label>
          <label><span>Deadline (giây)</span>{numberInput(deadlineSeconds, setDeadlineSeconds, 30, 1800)}</label>
        </>}
        {scanMode === 'dense' && <>
          <label><span>Tỷ lệ giữ cho CLIP</span>{numberInput(prefilterRatio, setPrefilterRatio, 0.001, 0.5, 0.005)}</label>
          <label><span>Tỷ lệ gửi Luna</span>{numberInput(vlmRatio, setVlmRatio, 0.0001, 0.2, 0.0005)}</label>
        </>}
        <label><span>Max batches</span>{numberInput(maxBatches, setMaxBatches, 0, 100000)}<small>0 = đến khi đạt điểm/deadline</small></label>
        <label><span>Worker ID</span><input value={workerId} onChange={(event) => setWorkerId(event.target.value)} /></label>
        <label><span>Model (tùy chọn)</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Để trống = đọc .env" /></label>
        <label><span>VLM Base URL (tùy chọn)</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="Để trống = đọc .env" /></label>
      </div>
      <label className="agent-checkbox"><input type="checkbox" checked={pilot} onChange={(event) => setPilot(event.target.checked)} /><span>Pilot: chỉ chạy một batch để kiểm tra cấu hình</span></label>
      {scanMode === 'temporal_zoom' && <p className="agent-warning">Competition Fast: 3 video, 2 cửa sổ/video, 1 FPS, storyboard 4×4 và deadline 5 phút. Không đủ tốt thì tạo run mới bằng Balanced fallback.</p>}
      {scanMode === 'dense' && <p className="agent-warning">Dense có thể mất nhiều giờ. Chỉ dùng kiểm tra offline, không dùng trong 3 giờ thi.</p>}
      <div className="agent-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Đang tạo run…' : 'Tạo agent run'}</button>{run && <><button className="secondary-button" type="button" onClick={() => void refresh(run.run_id)} disabled={busy}>Làm mới</button><button className="secondary-button" type="button" onClick={() => void stopRun()} disabled={busy || run.status !== 'running'}>Dừng run</button></>}</div>
    </form>

    {run && <div className="agent-run-card"><div><strong>run_id:</strong> <code>{run.run_id}</code></div><div className="agent-progress">Mode {run.scan_mode ?? scanMode} · Video {run.videos_examined ?? 0}/{run.videos_total ?? videoBudget} · Sample {run.frames_examined ?? 0}/{run.frames_total ?? '—'} · Judgment {run.judgment_count ?? 0}</div><p className="agent-help">Nút trên chỉ tạo run. Muốn agent bắt đầu, copy lệnh sau vào PowerShell tại thư mục repo:</p><div className="agent-command"><code>{command}</code><button type="button" className="icon-button" onClick={() => void copyCommand()}>Copy</button></div></div>}
    {notice && <p className="agent-notice">{notice}</p>}{error && <p className="agent-error" role="alert">{error}</p>}
  </section>;
}
