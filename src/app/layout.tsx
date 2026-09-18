import { DevTools } from '@/components/dev-tools';
import { ProjectTitleInitScript } from '@/components/project-title-init';
import { ThemeInitScript } from '@/components/theme-init';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
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
  description: `${PRODUCT_NAME} project board`,
  icons: [
    { rel: 'icon', url: '/icon.svg', type: 'image/svg+xml' },
    // iOS reads neither the manifest's icons nor an SVG, so the home-screen
    // tile comes from here or it is a screenshot of the page (bw-ndlu.2).
    { rel: 'apple-touch-icon', url: '/apple-touch-icon.png', sizes: '180x180' },
  ],
  manifest: '/manifest.webmanifest',
  // What the title bar says once iOS is running this as its own app rather
  // than as a tab, where the <title> would be the whole page's.
  appleWebApp: { capable: true, title: PRODUCT_NAME, statusBarStyle: 'black-translucent' },
  // `appleWebApp` above writes only Apple's own spelling, which Chrome has
  // deprecated in favour of this one. Both are set: Safari still reads only
  // the Apple name, and without this Chrome logs a warning on every visit.
  other: { 'mobile-web-app-capable': 'yes' },
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
        <ProjectTitleInitScript />
      </head>
      <body className="flex min-h-screen flex-col bg-background antialiased transition-colors duration-300">
        {/* One for the whole app. Hover labels used to bring their own provider
            wherever one was wanted, which is what made moving between two
            buttons re-serve the delay each time, and what let three different
            hover mechanisms grow up unnoticed (bw-6wq6.1). */}
        <TooltipProvider>
          {/* Around the screens rather than beside them: the button that opens
              a shell is on the bar of every screen that has one, and all of
              them have to find the same window with the same shells in it. */}
          <Terminals>
            <div className="flex-1">{children}</div>
          </Terminals>
          <UpdateBanner />
          <DevTools />
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
