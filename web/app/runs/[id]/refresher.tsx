'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresher({ enabled }: { enabled: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      router.refresh();
    }, 1500);
    return () => window.clearInterval(id);
  }, [enabled, router]);

  return null;
}
