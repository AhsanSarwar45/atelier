import { DevTools } from '@/components/dev-tools';
import { ThemeInitScript } from '@/components/theme-init';
import { Toaster } from '@/components/ui/toaster';
import { UpdateBanner } from '@/components/update-banner';

import { PRODUCT_NAME } from '@/lib/identity';
import { Terminals } from '@/workbench/terminal-tabs';

import type { Metadata } from 'next';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource-variable/space-grotesk/wght.css';
import '@fontsource/space-mono/latin.css';
import './globals.css';

export const metadata: Metadata = {
  // Read from the one place the product's name is written down, never typed.
  title: PRODUCT_NAME,
  description: `${PRODUCT_NAME} — a visual board for your work: cards, epics and projects, across every repository you track`,
  icons: [{ rel: 'icon', url: '/favicon.svg', type: 'image/svg+xml' }],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <ThemeInitScript />
      </head>
      <body className="flex min-h-screen flex-col bg-background antialiased transition-colors duration-300">
        {/* Around the screens rather than beside them: the button that opens a
            shell is on the bar of every screen that has one, and all of them
            have to find the same window with the same shells in it. */}
        <Terminals>
          <div className="flex-1">{children}</div>
        </Terminals>
        <UpdateBanner />
        <DevTools />
        <Toaster />
      </body>
    </html>
  );
}
