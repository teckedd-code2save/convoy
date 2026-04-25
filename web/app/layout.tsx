import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: 'Convoy',
  description: 'Deployment agent that rehearses, ships, and observes — without touching your code.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body>
        <div className="min-h-dvh flex flex-col">
          <header className="border-b border-rule/60 backdrop-blur-sm bg-paper/70 sticky top-0 z-20">
            <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
              <a href="/" className="flex items-center gap-3">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--color-accent-glow)]" />
                <span className="font-semibold tracking-tight text-base">Convoy</span>
                <span className="text-muted text-sm font-normal hidden sm:inline">rehearse · ship · observe</span>
              </a>
              <nav className="flex items-center gap-5 text-sm text-muted">
                <a href="/" className="hover:text-ink transition-colors">Home</a>
                <a href="/plans" className="hover:text-ink transition-colors">Plans</a>
                <a href="/runs" className="hover:text-ink transition-colors">Runs</a>
                <a
                  href="https://github.com/teckedd-code2save/convoy"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-ink transition-colors"
                >
                  Source
                </a>
              </nav>
            </div>
          </header>
          <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-10">{children}</main>
          <footer className="border-t border-rule/60 py-5 text-xs text-muted">
            <div className="max-w-5xl mx-auto px-6 flex justify-between">
              <span>Convoy — built with Opus 4.7</span>
              <span>We ship your code — we don&apos;t rewrite it.</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
