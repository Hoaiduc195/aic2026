'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000 },
      mutations: { retry: false },
    },
  }));

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
