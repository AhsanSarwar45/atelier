import { PRODUCT_NAME } from '@/lib/identity';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: `Settings | ${PRODUCT_NAME}` };

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
