'use client';

import { Providers } from './providers';
import { Workbench } from '../components/Workbench';
import {
  createSubmissionPreview,
  getVideoFrame,
  getVideoKeyframe,
  getVideoStudio,
  improveQuery,
  saveSelection,
  searchExactFrames,
  searchMedia,
  suggestVqaAnswer,
} from '../lib/api';

export default function HomePage() {
  return (
    <Providers>
      <Workbench
        search={searchMedia}
        exactFrameSearch={searchExactFrames}
        loadFrame={getVideoFrame}
        loadKeyframe={getVideoKeyframe}
        loadStudio={getVideoStudio}
        saveSelection={saveSelection}
        createPreview={createSubmissionPreview}
        suggestVqaAnswer={suggestVqaAnswer}
        improveQuery={improveQuery}
      />
    </Providers>
  );
}
