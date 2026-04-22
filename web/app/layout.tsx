import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Convoy',
  description: 'Deployment agent that rehearses, ships, and observes — without touching your code.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-dvh flex flex-col">
          <header className="border-b border-[color:var(--color-rule)]">
            <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
              <a href="/" className="flex items-center gap-3">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-[color:var(--color-accent)]" />
                <span className="font-semibold tracking-tight">Convoy</span>
                <span className="text-[color:var(--color-muted)] text-sm font-normal">rehearse · ship · observe</span>
              </a>
              <nav className="flex items-center gap-5 text-sm text-[color:var(--color-muted)]">
                <a href="/" className="hover:text-[color:var(--color-ink)]">Plans</a>
                <a href="/runs" className="hover:text-[color:var(--color-ink)]">Runs</a>
                <a
                  href="https://github.com/teckedd-code2save/convoy"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-[color:var(--color-ink)]"
                >
                  Source
                </a>
              </nav>
            </div>
          </header>
          <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-10">{children}</main>
          <footer className="border-t border-[color:var(--color-rule)] py-5 text-xs text-[color:var(--color-muted)]">
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
