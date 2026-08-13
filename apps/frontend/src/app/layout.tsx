import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'AIC Search · Tìm kiếm video theo frame',
  description: 'Không gian truy hồi và xác minh frame cho vòng sơ tuyển AIC 2026',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body>{children}</body></html>;
}
