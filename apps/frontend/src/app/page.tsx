'use client';

import { Providers } from './providers';
import { Workbench } from '../components/Workbench';
import {
  createSubmissionPreview,
  getVideoFrames,
  getVideoStudio,
  saveSelection,
  searchMedia,
  suggestVqaAnswer,
} from '../lib/api';

export default function HomePage() {
  return (
    <Providers>
      <Workbench
        search={searchMedia}
        loadFrames={getVideoFrames}
        loadStudio={getVideoStudio}
        saveSelection={saveSelection}
        createPreview={createSubmissionPreview}
        suggestVqaAnswer={suggestVqaAnswer}
      />
    </Providers>
  );
}
