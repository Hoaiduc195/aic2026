'use client';

import { Providers } from './providers';
import { AgentPanel } from '../components/AgentPanel';
import { Workbench } from '../components/Workbench';
import {
  createSubmissionPreview,
  getVideoFrame,
  getVideoFrames,
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
      <div className="page-stack">
        <AgentPanel />
        <Workbench
          search={searchMedia}
          exactFrameSearch={searchExactFrames}
          loadFrame={getVideoFrame}
          loadKeyframe={getVideoKeyframe}
          loadFrames={getVideoFrames}
          loadStudio={getVideoStudio}
          saveSelection={saveSelection}
          createPreview={createSubmissionPreview}
          suggestVqaAnswer={suggestVqaAnswer}
          improveQuery={improveQuery}
        />
      </div>
    </Providers>
  );
}
