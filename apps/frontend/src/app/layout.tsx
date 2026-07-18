import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'AIC HCMC 2026 Workbench',
  description: 'Timestamp-accurate multimodal evidence retrieval',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
