"use client";

import { Monitor } from "lucide-react";
import { useEffect, useRef } from "react";

const W = 360;
const H = 260;
const CX = W / 2;
const CY = H / 2;

interface CircleSpec {
  r: number;
}

const SPECS: CircleSpec[] = [
  { r: 44 },
  { r: 36 },
  { r: 32 },
  { r: 30 },
  { r: 28 },
  { r: 26 },
  { r: 24 },
  { r: 22 },
  { r: 22 },
  { r: 20 },
  { r: 20 },
  { r: 19 },
  { r: 18 },
  { r: 17 },
  { r: 17 },
  { r: 16 },
  { r: 15 },
  { r: 15 },
  { r: 14 },
  { r: 14 },
  { r: 13 },
  { r: 13 },
  { r: 12 },
  { r: 12 },
  { r: 11 },
  { r: 22 },
];

const GAP = 5;

interface Body {
  x: number;
  y: number;
  px: number;
  py: number;
  r: number;
  invMass: number;
}

// Seeded LCG so initial positions are identical on server and client (no hydration mismatch).
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function makeBodies(): Body[] {
  const rand = seededRandom(7);
  return SPECS.map((spec) => {
    const angle = rand() * Math.PI * 2;
    const radius = 30 + rand() * 70;
    const x = CX + Math.cos(angle) * radius;
    const y = CY + Math.sin(angle) * radius;
    return {
      x,
      y,
      px: x,
      py: y,
      r: spec.r,
      invMass: 1 / (spec.r * spec.r),
    };
  });
}

const DAMPING = 0.92;
const GRAVITY = 0.18;
const CURSOR_RADIUS = 110;
const CURSOR_STRENGTH = 2.6;
const COLLISION_ITERS = 3;

function step(bodies: Body[], cursor: { x: number; y: number } | null) {
  for (const b of bodies) {
    let ax = 0;
    let ay = 0;

    const dx = CX - b.x;
    const dy = CY - b.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    ax += (dx / d) * GRAVITY;
    ay += (dy / d) * GRAVITY;

    if (cursor) {
      const cdx = b.x - cursor.x;
      const cdy = b.y - cursor.y;
      const cd = Math.hypot(cdx, cdy) || 0.0001;
      if (cd < CURSOR_RADIUS) {
        const t = 1 - cd / CURSOR_RADIUS;
        const force = t * t * CURSOR_STRENGTH;
        ax += (cdx / cd) * force;
        ay += (cdy / cd) * force;
      }
    }

    const vx = (b.x - b.px) * DAMPING + ax;
    const vy = (b.y - b.py) * DAMPING + ay;
    b.px = b.x;
    b.py = b.y;
    b.x += vx;
    b.y += vy;
  }

  for (let iter = 0; iter < COLLISION_ITERS; iter++) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const min = a.r + b.r + GAP;
        if (dist < min) {
          const overlap = min - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const totalInvMass = a.invMass + b.invMass;
          const aShare = a.invMass / totalInvMass;
          const bShare = b.invMass / totalInvMass;
          a.x -= nx * overlap * aShare;
          a.y -= ny * overlap * aShare;
          b.x += nx * overlap * bShare;
          b.y += ny * overlap * bShare;
        }
      }
    }

    for (const b of bodies) {
      if (b.x - b.r < 0) { b.x = b.r; }
      if (b.x + b.r > W) { b.x = W - b.r; }
      if (b.y - b.r < 0) { b.y = b.r; }
      if (b.y + b.r > H) { b.y = H - b.r; }
    }
  }
}

function makeWarmedBodies(): Body[] {
  const bodies = makeBodies();
  for (let i = 0; i < 300; i++) {
    step(bodies, null);
  }
  return bodies;
}

export function ComputerCluster() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const bodiesRef = useRef<Body[]>(makeWarmedBodies());
  const cursorRef = useRef<{ x: number; y: number } | null>(null);

  // Render once with warmed positions; the rAF loop mutates transforms directly.
  const initialBodies = bodiesRef.current;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) { return; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { return; }

    const bodies = bodiesRef.current;
    const nodes = nodeRefs.current;
    let raf = 0;
    let visible = true;
    let tabVisible = document.visibilityState === "visible";

    const writeTransforms = () => {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        const node = nodes[i];
        if (node) {
          node.style.transform = `translate3d(${b.x - b.r}px, ${b.y - b.r}px, 0)`;
        }
      }
    };

    const loop = () => {
      step(bodies, cursorRef.current);
      writeTransforms();
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (raf !== 0) { return; }
      if (!visible || !tabVisible) { return; }
      raf = requestAnimationFrame(loop);
    };

    const stop = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) { return; }
        visible = entry.isIntersecting;
        if (visible) {
          console.log("ComputerCluster: onscreen, resuming");
          start();
        } else {
          console.log("ComputerCluster: offscreen, pausing");
          stop();
        }
      },
      { threshold: 0 },
    );
    observer.observe(container);

    const handleVisibility = () => {
      tabVisible = document.visibilityState === "visible";
      if (tabVisible) { start(); }
      else { stop(); }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-[260px] w-[360px] max-w-full"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }}
      onPointerLeave={() => {
        cursorRef.current = null;
      }}
    >
      {initialBodies.map((b, i) => {
        const size = b.r * 2;
        return (
          <div
            key={i}
            ref={(el) => {
              nodeRefs.current[i] = el;
            }}
            className="absolute left-0 top-0 flex items-center justify-center rounded-full border border-brand-border bg-white/8"
            style={{
              width: size,
              height: size,
              transform: `translate3d(${b.x - b.r}px, ${b.y - b.r}px, 0)`,
            }}
          >
            <Monitor
              className="text-brand-lavender"
              strokeWidth={1.75}
              style={{ width: size * 0.5, height: size * 0.5 }}
            />
          </div>
        );
      })}
    </div>
  );
}
