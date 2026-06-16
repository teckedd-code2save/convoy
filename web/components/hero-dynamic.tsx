'use client';

// Client-only dynamic imports for the canvas-based hero components.
// `ssr: false` is only permitted inside a Client Component, so these live here
// and are re-exported into the server-rendered home page.
import dynamicImport from 'next/dynamic';

export const PipelineHero = dynamicImport(
  () => import('@/components/pipeline-hero').then(m => ({ default: m.PipelineHero })),
  { ssr: false },
);

export const HeroCards = dynamicImport(
  () => import('@/components/hero-cards').then(m => ({ default: m.HeroCards })),
  { ssr: false },
);

export const Starfield = dynamicImport(
  () => import('@/components/starfield').then(m => ({ default: m.Starfield })),
  { ssr: false },
);
