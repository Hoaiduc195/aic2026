'use client';

import { Workbench } from '../components/Workbench';
import { searchMedia } from '../lib/api';

export default function Home() {
  return <Workbench search={searchMedia} />;
}
