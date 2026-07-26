"use client";

import { Laptop, Smartphone, Tablet } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useEffect, useState } from "react";

const W = 320;
const H = 240;
const ICON_SIZE = 64;

interface Anchor {
  x: number;
  y: number;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  amp: number;
  period: number;
  phase: number;
}

const ANCHORS: Anchor[] = [
  { x: 90, y: 90, Icon: Tablet, amp: 7, period: 7.0, phase: 0 },
  { x: 230, y: 90, Icon: Laptop, amp: 6, period: 8.5, phase: 1.2 },
  { x: 160, y: 180, Icon: Smartphone, amp: 8, period: 7.8, phase: 2.6 },
];

const PAIRS: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 2],
];

function useTime(): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { return; }
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      setT((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}

export function DeviceConnections() {
  const t = useTime();

  const positions = ANCHORS.map((a) => {
    const phase = (t * 2 * Math.PI) / a.period + a.phase;
    return {
      Icon: a.Icon,
      cx: a.x + Math.cos(phase) * a.amp * 0.6,
      cy: a.y + Math.sin(phase) * a.amp,
    };
  });

  const centroidX = positions.reduce((s, p) => s + p.cx, 0) / positions.length;
  const centroidY = positions.reduce((s, p) => s + p.cy, 0) / positions.length;

  // Quadratic bezier per pair, with the control point pulled inward toward
  // the triangle centroid so the curves bow toward each other (convex).
  const curves = PAIRS.map(([i, j]) => {
    const p1 = positions[i]!;
    const p2 = positions[j]!;
    const mx = (p1.cx + p2.cx) / 2;
    const my = (p1.cy + p2.cy) / 2;
    const dx = mx - centroidX;
    const dy = my - centroidY;
    const len = Math.hypot(dx, dy) || 1;
    const bulge = 22;
    const cx = mx - (dx / len) * bulge;
    const cy = my - (dy / len) * bulge;
    return `M ${p1.cx} ${p1.cy} Q ${cx} ${cy} ${p2.cx} ${p2.cy}`;
  });

  return (
    <div className="relative max-w-full overflow-hidden" style={{ width: W, height: H }}>
      <svg
        aria-hidden
        className="absolute inset-0"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
      >
        {curves.map((d, i) => (
          <path
            key={i}
            d={d}
            stroke="var(--brand-lavender)"
            opacity={0.45}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
          />
        ))}
      </svg>
      {positions.map(({ cx, cy, Icon }, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: cx - ICON_SIZE / 2,
            top: cy - ICON_SIZE / 2,
            width: ICON_SIZE,
            height: ICON_SIZE,
          }}
        >
          <span
            aria-hidden
            className="absolute inset-0 animate-ping rounded-full bg-brand-lavender/20"
            style={{ animationDuration: "2.4s", animationDelay: `${i * 0.7}s` }}
          />
          <span className="relative flex h-full w-full items-center justify-center rounded-full border border-brand-border bg-brand-surface">
            <Icon className="h-7 w-7 text-brand-lavender" strokeWidth={1.75} />
          </span>
        </div>
      ))}
    </div>
  );
}
