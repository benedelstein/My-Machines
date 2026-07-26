"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";

export function StickyHeader({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > window.innerHeight * 0.5);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-20">
      <div
        className={`absolute inset-0 border-b border-white/10 bg-brand-navy-deep/80 backdrop-blur-xl transition-opacity duration-300 ${
          scrolled ? "opacity-100" : "opacity-0"
        }`}
      />
      <div className="relative flex h-full items-center justify-between px-5 md:px-8">
        <button
          type="button"
          onClick={scrollToTop}
          aria-label="Scroll to top"
          aria-hidden={!scrolled}
          tabIndex={scrolled ? 0 : -1}
          className={`font-brand text-xl leading-none text-white transition-all duration-300 motion-reduce:transition-none md:text-2xl ${
            scrolled
              ? "translate-y-0 opacity-100"
              : "-translate-y-1 opacity-0 motion-reduce:translate-y-0"
          }`}
        >
          My Machines
        </button>
        <div>{children}</div>
      </div>
    </header>
  );
}
