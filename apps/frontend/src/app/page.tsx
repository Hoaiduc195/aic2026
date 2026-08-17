'use client';

import { Providers } from './providers';
import { Workbench } from '../components/Workbench';
import {
  createSubmissionPreview,
  getVideoFrames,
  getVideoPlayback,
  saveSelection,
  searchMedia,
  suggestVqaAnswer,
} from '../lib/api';

export default function HomePage() {
  return (
    <Providers>
      <Workbench
        search={searchMedia}
        loadPlayback={getVideoPlayback}
        loadFrames={getVideoFrames}
        saveSelection={saveSelection}
        createPreview={createSubmissionPreview}
        suggestVqaAnswer={suggestVqaAnswer}
      />
    </Providers>
  );
}
