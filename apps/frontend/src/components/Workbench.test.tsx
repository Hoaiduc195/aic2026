import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Workbench } from './Workbench';
import type { SearchResponse } from '../lib/contracts';

const response: SearchResponse = {
  request_id: 'req-1',
  query_id: 'query-1',
  query: 'xe buýt Bến Thành',
  task: 'textual_kis',
  executor: 'textual_kis',
  versions: {
    dataset_id: 'golden',
    dataset_version: '1',
    pipeline_version: '1',
    schema_version: '1',
    index_version: '1',
    model_revisions: { ocr: 'fixture' },
    activation_state: 'active',
  },
  confidence: 0.8,
  degraded: true,
  unavailable_branches: ['asr'],
  branches: [],
  results: [
    {
      segment_id: 'seg-1',
      video_id: 'vid-1',
      start_ms: 1000,
      end_ms: 2500,
      preview_uri: 'https://media.invalid/vid-1.mp4',
      score: 0.9,
      matched_modalities: ['ocr'],
      evidence_ids: ['ev-ocr-ben-thanh'],
      versions: {
        dataset_id: 'golden', dataset_version: '1', pipeline_version: '1', schema_version: '1', index_version: '1',
        model_revisions: { ocr: 'fixture' }, activation_state: 'active',
      },
    },
  ],
  timing_ms: { planning: 1, retrieval: 2, fusion: 1, total: 4 },
};

describe('Workbench', () => {
  it('searches, selects a result, and exposes evidence and degraded state', async () => {
    const search = async () => response;
    render(<Workbench search={search} />);

    fireEvent.change(screen.getByLabelText('Search multimedia'), {
      target: { value: 'xe buýt Bến Thành' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('ev-ocr-ben-thanh')).toBeInTheDocument();
    expect(screen.getByText(/ASR unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /vid-1/i }));
    expect(screen.getAllByText(/1000–2500 ms/i)).toHaveLength(2);
  });

  it('does not expose a live submit action', () => {
    render(<Workbench search={async () => response} />);
    expect(screen.queryByRole('button', { name: /submit now/i })).not.toBeInTheDocument();
  });

  it('reports failures and empty result sets without losing the query', async () => {
    const search = async () => { throw new Error('Branch service failed.'); };
    render(<Workbench search={search} />);
    const input = screen.getByLabelText('Search multimedia');
    fireEvent.change(input, { target: { value: '  query  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Branch service failed.');
    expect(input).toHaveValue('  query  ');
  });

  it('supports task selection and arrow-key result navigation', async () => {
    const second = { ...response.results[0], segment_id: 'seg-2', video_id: 'vid-2' };
    const search = async () => ({ ...response, degraded: false, unavailable_branches: [], results: [response.results[0], second] });
    render(<Workbench search={search} />);
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'avs' } });
    fireEvent.change(screen.getByLabelText('Search multimedia'), { target: { value: 'people walking' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const grid = await screen.findByLabelText('Search results');
    expect(screen.getByRole('heading', { name: 'vid-1' })).toBeInTheDocument();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'vid-2' })).toBeInTheDocument();
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(screen.getByRole('heading', { name: 'vid-1' })).toBeInTheDocument();
  });
});
