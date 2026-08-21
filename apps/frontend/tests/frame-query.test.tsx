import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FrameGrid } from '@/components/workbench/FrameGrid';
import type { FrameCandidate } from '@/lib/contracts';

const frame: FrameCandidate = {
  result_key: 'video_01:385',
  video_id: 'video_01',
  original_frame_id: 385,
  timestamp_ms: 12_800,
  thumbnail_uri: '/frame.jpg',
  start_ms: 12_000,
  end_ms: 13_000,
  score: 0.91,
  evidence: [],
  matched_modalities: ['embedding'],
};

describe('frame image query action', () => {
  it('requires confirmation before starting an image-only query', async () => {
    const user = userEvent.setup();
    const onQueryFrame = vi.fn();

    render(
      <FrameGrid
        frames={[frame]}
        selectedKey={null}
        loading={false}
        searched
        skipped={0}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onQueryFrame={onQueryFrame}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Tìm kiếm bằng/ }));
    expect(screen.getByRole('dialog', { name: 'Xác nhận tìm kiếm trên frame này' })).toBeInTheDocument();
    expect(onQueryFrame).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Huỷ' }));
    expect(onQueryFrame).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Tìm kiếm bằng/ }));
    await user.click(screen.getByRole('button', { name: 'Xác nhận tìm kiếm' }));
    expect(onQueryFrame).toHaveBeenCalledWith(frame);
  });
});
