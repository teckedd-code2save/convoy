'use client';

import { useEffect } from 'react';

/**
 * Auto-anchor the failure spotlight on first mount so the operator
 * lands on the breach instead of the page top. Uses a 60px sticky-header
 * offset so the failure card isn't tucked under the layout chrome.
 *
 * Server-side anchor (`#failed-event` with native browser scroll) was
 * the first attempt, but it ignores sticky headers and lands the
 * spotlight half-hidden. This component does the math itself.
 */
export function ScrollIntoFailure() {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-failed-event]');
    if (!el) return;
    // Skip if the user landed already-scrolled (mid-investigation reload).
    if (window.scrollY > 200) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: 'smooth' });
  }, []);
  return null;
}
