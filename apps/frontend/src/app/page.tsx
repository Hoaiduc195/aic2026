'use client';

import { Providers } from './providers';
import { Workbench } from '../components/Workbench';
import { getVideoFrames, getVideoPlayback, searchMedia } from '../lib/api';

export default function HomePage() {
  return (
    <Providers>
      <Workbench search={searchMedia} loadPlayback={getVideoPlayback} loadFrames={getVideoFrames} />
    </Providers>
  );
}
