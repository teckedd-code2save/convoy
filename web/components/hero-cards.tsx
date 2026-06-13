'use client';

import { useEffect, useRef, useState } from 'react';

interface FloatCardProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}

function FloatCard({ children, delay = 0, className = '' }: FloatCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame: number;
    const start = performance.now() + delay * 1000;

    const animate = (now: number) => {
      const t = (now - start) / 1000;
      const y = Math.sin(t * 0.6) * 6;
      const rotX = Math.sin(t * 0.4) * 2;
      const rotY = Math.cos(t * 0.35) * 1.5;
      el.style.transform = `translateY(${y}px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [delay]);

  return (
    <div
      ref={ref}
      className={`rounded-xl border border-rule/60 bg-card/90 backdrop-blur-sm p-4 text-xs font-mono shadow-2xl ${className}`}
      style={{ transformStyle: 'preserve-3d', willChange: 'transform' }}
    >
      {children}
    </div>
  );
}

export function HeroCards() {
  const [tick, setTick] = useState(0);
  const [p99, setP99] = useState(142);
  const [traffic, setTraffic] = useState(5);
  const [errorRate, setErrorRate] = useState(0.0);

  useEffect(() => {
    const id = setInterval(() => {
      setTick(t => t + 1);
      setP99(v => Math.max(80, Math.min(200, v + (Math.random() - 0.5) * 12)));
      setTraffic(v => v >= 100 ? 5 : v + (Math.random() > 0.85 ? 10 : 0));
      setErrorRate(v => Math.max(0, Math.min(0.8, v + (Math.random() - 0.52) * 0.05)));
    }, 1200);
    return () => clearInterval(id);
  }, []);

  const phases = ['scan', 'orient', 'pick', 'rehearse', 'author', 'canary', 'promote', 'observe'];
  const phase = phases[tick % phases.length]!;

  return (
    <div className="relative w-full h-64 pointer-events-none select-none" style={{ perspective: '800px' }}>
      {/* Scan card — top left */}
      <div className="absolute top-0 left-0" style={{ width: 200 }}>
        <FloatCard delay={0}>
          <div className="text-accent mb-2 font-semibold text-[10px] uppercase tracking-wider">Scan signals</div>
          <div className="space-y-1 text-muted">
            <div className="flex justify-between"><span>ecosystem</span><span className="text-ink">node</span></div>
            <div className="flex justify-between"><span>framework</span><span className="text-ink">express</span></div>
            <div className="flex justify-between"><span>topology</span><span className="text-ink">api + worker</span></div>
            <div className="flex justify-between"><span>data layer</span><span className="text-ink">postgres</span></div>
            <div className="flex justify-between"><span>dockerfile</span><span className="text-green-400">found</span></div>
          </div>
        </FloatCard>
      </div>

      {/* Platform score — top right */}
      <div className="absolute top-2 right-0" style={{ width: 200 }}>
        <FloatCard delay={0.8}>
          <div className="text-accent mb-2 font-semibold text-[10px] uppercase tracking-wider">Platform score</div>
          <div className="space-y-1.5">
            {[
              { name: 'fly',      score: 95, color: '#6ea8ff' },
              { name: 'railway',  score: 70, color: '#38d399' },
              { name: 'vercel',   score: 42, color: '#f5a524' },
              { name: 'cloudrun', score: 38, color: '#8a8a99' },
            ].map(p => (
              <div key={p.name} className="flex items-center gap-2">
                <span className="text-muted w-14 shrink-0">{p.name}</span>
                <div className="flex-1 h-1 rounded-full bg-rule overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${p.score}%`, background: p.color, boxShadow: `0 0 6px ${p.color}66` }}
                  />
                </div>
                <span style={{ color: p.color }} className="w-6 text-right">{p.score}</span>
              </div>
            ))}
          </div>
        </FloatCard>
      </div>

      {/* Live metrics — bottom center */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2" style={{ width: 220 }}>
        <FloatCard delay={1.4}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-accent font-semibold text-[10px] uppercase tracking-wider">Canary metrics</span>
            <span className="flex items-center gap-1 text-[10px] text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
              live
            </span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted">traffic</span>
              <span style={{ color: traffic >= 50 ? '#38d399' : '#6ea8ff' }}>{traffic}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">p99 latency</span>
              <span style={{ color: p99 > 150 ? '#f5a524' : '#38d399' }}>{p99.toFixed(0)}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">error rate</span>
              <span style={{ color: errorRate > 0.5 ? '#ef4444' : '#38d399' }}>{errorRate.toFixed(2)}%</span>
            </div>
            <div className="mt-2 pt-2 border-t border-rule flex justify-between">
              <span className="text-muted">stage</span>
              <span className="text-accent">{phase}</span>
            </div>
          </div>
        </FloatCard>
      </div>

      {/* Medic card — bottom left */}
      <div className="absolute bottom-4 left-8" style={{ width: 180 }}>
        <FloatCard delay={2.1}>
          <div className="flex items-center gap-1.5 mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-medic animate-pulse" />
            <span style={{ color: 'var(--color-medic)' }} className="font-semibold text-[10px] uppercase tracking-wider">Medic</span>
          </div>
          <p className="text-muted leading-relaxed">
            Found <code className="text-ink px-0.5">renderLock</code> in <code className="text-ink px-0.5">routes/render.ts</code> — replace with semaphore.
          </p>
        </FloatCard>
      </div>
    </div>
  );
}
