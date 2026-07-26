"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface BrandButtonProps {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "quiet";
}

export function BrandButton({
  children,
  className,
  disabled,
  href,
  onClick,
  variant = "primary",
}: BrandButtonProps) {
  const sharedClassName = cn(
    "group inline-flex shrink-0 items-center justify-center gap-2 rounded-full border font-semibold",
    "transition-[background-color,border-color,scale] duration-200 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-lavender",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-brand-navy-deep",
    "disabled:pointer-events-none disabled:opacity-60 active:scale-[0.97]",
    variant === "primary" &&
      "border-white/20 bg-white text-brand-navy-deep shadow-brand hover:scale-[1.01] hover:border-brand-lavender/35 hover:bg-brand-button-hover",
    variant === "quiet" &&
      "border-white/20 bg-white/8 text-white backdrop-blur-xl hover:bg-white/14",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={sharedClassName}>
        {children}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={sharedClassName}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
