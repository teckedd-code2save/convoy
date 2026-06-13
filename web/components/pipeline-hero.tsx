'use client';

import { useEffect, useRef, useState } from 'react';

interface Stage {
  id: string;
  label: string;
  desc: string;
  color: string;
  glow: string;
  x: number;
  y: number;
}

const STAGES: Stage[] = [
  { id: 'scan',     label: 'Scan',     desc: 'Reads your repo — ecosystem, framework, topology, secrets, risks. No annotations needed.',        color: '#6ea8ff', glow: 'rgba(110,168,255,0.4)', x: 0,   y: 0 },
  { id: 'orient',   label: 'Orient',   desc: 'Compares repo artifacts against your team preferences. Surfaces drift. Never re-scores silently.', color: '#38d399', glow: 'rgba(56,211,153,0.4)',  x: 1,   y: 0 },
  { id: 'pick',     label: 'Pick',     desc: 'Scores platforms from repo signals. Mandate from onboard wins. Inspectable score table.',           color: '#6ea8ff', glow: 'rgba(110,168,255,0.4)', x: 2,   y: 0 },
  { id: 'rehearse', label: 'Rehearse', desc: 'Spawns your service locally, hits it with synthetic load, scrapes real metrics. Catches bugs before the PR.',    color: '#f5a524', glow: 'rgba(245,165,36,0.4)',  x: 3,   y: 0 },
  { id: 'author',   label: 'Author',   desc: 'Writes only the files you need: Dockerfile, platform config, CI workflow, .env.schema. Nothing else.',color: '#6ea8ff', glow: 'rgba(110,168,255,0.4)', x: 4,   y: 0 },
  { id: 'canary',   label: 'Canary',   desc: '5% traffic first. Compares p99 delta. Auto-promotes when signals stay green.',                       color: '#38d399', glow: 'rgba(56,211,153,0.4)',  x: 5,   y: 0 },
  { id: 'promote',  label: 'Promote',  desc: '10% → 25% → 50% → 100%. Each step gated by real error-rate and latency signals.',                   color: '#38d399', glow: 'rgba(56,211,153,0.4)',  x: 6,   y: 0 },
  { id: 'observe',  label: 'Observe',  desc: '120s post-deploy watch. If signals breach, rollback fires — the previous release is already staged.', color: '#c084fc', glow: 'rgba(192,132,252,0.4)', x: 7,   y: 0 },
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  stageIdx: number;
  progress: number;
}

export function PipelineHero() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeStage, setActiveStage] = useState<Stage | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.scale(dpr, dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const getNodePositions = () => {
      const rect = container.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const n = STAGES.length;
      const marginX = W * 0.08;
      const usableW = W - marginX * 2;
      const centerY = H * 0.48;
      return STAGES.map((_, i) => ({
        x: marginX + (i / (n - 1)) * usableW,
        y: centerY + Math.sin((i / (n - 1)) * Math.PI) * -H * 0.08,
      }));
    };

    const spawnParticle = (fromIdx: number) => {
      const positions = getNodePositions();
      const toIdx = Math.min(fromIdx + 1, STAGES.length - 1);
      const from = positions[fromIdx]!;
      particlesRef.current.push({
        x: from.x,
        y: from.y,
        vx: 0, vy: 0,
        life: 0,
        maxLife: 60 + Math.random() * 20,
        size: 2 + Math.random() * 2,
        color: STAGES[fromIdx]!.color,
        stageIdx: fromIdx,
        progress: 0,
      });
    };

    let frameCount = 0;
    const draw = () => {
      const rect = container.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      ctx.clearRect(0, 0, W, H);

      timeRef.current += 0.016;
      frameCount++;
      const t = timeRef.current;

      const positions = getNodePositions();

      // Background grid lines (subtle)
      ctx.strokeStyle = 'rgba(38,38,47,0.5)';
      ctx.lineWidth = 1;
      for (let i = 0; i < W; i += 60) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, H);
        ctx.stroke();
      }
      for (let j = 0; j < H; j += 60) {
        ctx.beginPath();
        ctx.moveTo(0, j);
        ctx.lineTo(W, j);
        ctx.stroke();
      }

      // Connection paths
      for (let i = 0; i < positions.length - 1; i++) {
        const from = positions[i]!;
        const to = positions[i + 1]!;
        const isHovered = hoveredIdx !== null && (i === hoveredIdx || i + 1 === hoveredIdx);

        // Base connector
        const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
        grad.addColorStop(0, STAGES[i]!.color + (isHovered ? 'cc' : '44'));
        grad.addColorStop(1, STAGES[i + 1]!.color + (isHovered ? 'cc' : '44'));
        ctx.strokeStyle = grad;
        ctx.lineWidth = isHovered ? 2 : 1.5;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        const cx = (from.x + to.x) / 2;
        const cy = (from.y + to.y) / 2 - 20;
        ctx.quadraticCurveTo(cx, cy, to.x, to.y);
        ctx.stroke();

        // Animated pulse along path
        const phase = (t * 0.6 + i * 0.18) % 1;
        const px = from.x + (to.x - from.x) * phase;
        const py = from.y + (to.y - from.y) * phase - Math.sin(phase * Math.PI) * 20;
        const pulseR = ctx.createRadialGradient(px, py, 0, px, py, 6);
        pulseR.addColorStop(0, STAGES[i]!.color + 'ff');
        pulseR.addColorStop(1, 'transparent');
        ctx.fillStyle = pulseR;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Spawn particles periodically
      if (frameCount % 12 === 0) {
        const idx = Math.floor(Math.random() * (STAGES.length - 1));
        spawnParticle(idx);
      }

      // Draw + update particles
      particlesRef.current = particlesRef.current.filter(p => p.life < p.maxLife);
      for (const p of particlesRef.current) {
        p.life++;
        p.progress = p.life / p.maxLife;
        const fromPos = positions[p.stageIdx]!;
        const toPos = positions[Math.min(p.stageIdx + 1, STAGES.length - 1)]!;
        const px = fromPos.x + (toPos.x - fromPos.x) * p.progress;
        const py = fromPos.y + (toPos.y - fromPos.y) * p.progress - Math.sin(p.progress * Math.PI) * 20;
        const alpha = Math.sin(p.progress * Math.PI);
        const gr = ctx.createRadialGradient(px, py, 0, px, py, p.size * 3);
        gr.addColorStop(0, p.color + Math.floor(alpha * 255).toString(16).padStart(2, '0'));
        gr.addColorStop(1, 'transparent');
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(px, py, p.size * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Stage nodes
      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i]!;
        const stage = STAGES[i]!;
        const isHovered = hoveredIdx === i;
        const pulse = Math.sin(t * 2 + i * 0.8) * 0.5 + 0.5;
        const r = isHovered ? 18 : 12 + pulse * 2;

        // Outer glow
        const outerR = ctx.createRadialGradient(pos.x, pos.y, r * 0.5, pos.x, pos.y, r * 3.5);
        outerR.addColorStop(0, stage.glow);
        outerR.addColorStop(1, 'transparent');
        ctx.fillStyle = outerR;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 3.5, 0, Math.PI * 2);
        ctx.fill();

        // Node ring
        ctx.strokeStyle = stage.color + (isHovered ? 'ff' : 'aa');
        ctx.lineWidth = isHovered ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.stroke();

        // Node fill
        const nodeGrad = ctx.createRadialGradient(pos.x - r * 0.3, pos.y - r * 0.3, 0, pos.x, pos.y, r);
        nodeGrad.addColorStop(0, 'rgba(20,20,26,0.95)');
        nodeGrad.addColorStop(1, 'rgba(10,10,11,0.98)');
        ctx.fillStyle = nodeGrad;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r - 1, 0, Math.PI * 2);
        ctx.fill();

        // Center dot
        const dotGrad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 5);
        dotGrad.addColorStop(0, stage.color);
        dotGrad.addColorStop(1, stage.color + '44');
        ctx.fillStyle = dotGrad;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, isHovered ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();

        // Label below
        const labelY = pos.y + r + 22;
        ctx.font = `${isHovered ? 'bold ' : ''}11px var(--font-sans, system-ui)`;
        ctx.textAlign = 'center';
        ctx.fillStyle = isHovered ? stage.color : 'rgba(138,138,153,0.9)';
        ctx.fillText(stage.label, pos.x, labelY);
      }

      // Stage index labels (number inside circle)
      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i]!;
        ctx.font = '9px var(--font-mono, monospace)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(138,138,153,0.5)';
        ctx.fillText(String(i + 1), pos.x, pos.y);
        ctx.textBaseline = 'alphabetic';
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const positions = getNodePositions();
      let found = null;
      for (let i = 0; i < positions.length; i++) {
        const dx = positions[i]!.x - mx;
        const dy = positions[i]!.y - my;
        if (Math.sqrt(dx * dx + dy * dy) < 28) { found = i; break; }
      }
      if (found !== null) {
        setHoveredIdx(found);
        setActiveStage(STAGES[found]!);
        canvas.style.cursor = 'pointer';
      } else {
        setHoveredIdx(null);
        canvas.style.cursor = 'default';
      }
    };

    const handleMouseLeave = () => { setHoveredIdx(null); };

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      cancelAnimationFrame(animRef.current);
      ro.disconnect();
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [hoveredIdx]);

  return (
    <div className="relative w-full" style={{ height: '320px' }}>
      <div ref={containerRef} className="absolute inset-0">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>

      {/* Stage tooltip */}
      <div
        className="absolute bottom-0 left-0 right-0 flex justify-center pointer-events-none"
        style={{ height: '72px' }}
      >
        <div
          className="transition-all duration-200 px-5 py-3 rounded-xl text-sm max-w-lg text-center"
          style={{
            opacity: activeStage ? 1 : 0,
            transform: activeStage ? 'translateY(0)' : 'translateY(8px)',
            background: 'rgba(20,20,26,0.92)',
            border: activeStage ? `1px solid ${activeStage.color}44` : '1px solid transparent',
            boxShadow: activeStage ? `0 0 24px ${activeStage.glow}` : 'none',
            backdropFilter: 'blur(12px)',
          }}
        >
          {activeStage && (
            <>
              <span style={{ color: activeStage.color }} className="font-semibold">
                {activeStage.label}
              </span>
              <span className="text-muted ml-2">{activeStage.desc}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
