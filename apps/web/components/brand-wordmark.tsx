"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const MAXIMUM_EXTRA_EYE_COUNT = 4;
const INTRO_DELAY_MS = 300;
const EYE_SEQUENCE_DELAY_MS = 850;
const EYE_HOLD_MS = 750;
const EYE_INSERTION_STAGGER_MS = 70;
const EYE_REMOVAL_STAGGER_MS = 65;

interface BrandWordmarkProps {
  animated?: boolean;
  className?: string;
  heading?: boolean;
  href?: string;
}

export function BrandWordmark({
  animated = false,
  className,
  heading = false,
  href,
}: BrandWordmarkProps) {
  const [isVisible, setIsVisible] = useState(!animated);
  const [extraEyeCount, setExtraEyeCount] = useState(0);
  const timeoutsRef = useRef<number[]>([]);
  const currentEyeCountRef = useRef(0);

  const clearSequence = useCallback(() => {
    for (const timeout of timeoutsRef.current) {
      window.clearTimeout(timeout);
    }
    timeoutsRef.current = [];
  }, []);

  const setEyeCount = useCallback((count: number) => {
    currentEyeCountRef.current = count;
    setExtraEyeCount(count);
  }, []);

  const scheduleEyes = useCallback(
    (startingCount: number, targetCount: number, initialDelay = 0) => {
      const direction = targetCount > startingCount ? 1 : -1;
      const stagger =
        direction > 0 ? EYE_INSERTION_STAGGER_MS : EYE_REMOVAL_STAGGER_MS;
      const stepCount = Math.abs(targetCount - startingCount);

      for (let step = 1; step <= stepCount; step += 1) {
        const nextCount = startingCount + direction * step;
        const timeout = window.setTimeout(() => {
          setEyeCount(nextCount);
        }, initialDelay + (step - 1) * stagger);
        timeoutsRef.current.push(timeout);
      }

      return initialDelay + Math.max(0, stepCount - 1) * stagger;
    },
    [setEyeCount],
  );

  const animateEyes = useCallback(
    (targetCount: number) => {
      scheduleEyes(currentEyeCountRef.current, targetCount);
    },
    [scheduleEyes],
  );

  useEffect(() => {
    if (!animated) {
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setIsVisible(true);
      return;
    }

    const revealTimeout = window.setTimeout(() => {
      setIsVisible(true);
    }, INTRO_DELAY_MS);
    timeoutsRef.current.push(revealTimeout);

    const expansionStart = INTRO_DELAY_MS + EYE_SEQUENCE_DELAY_MS;
    const expansionEnd = scheduleEyes(0, MAXIMUM_EXTRA_EYE_COUNT, expansionStart);
    scheduleEyes(
      MAXIMUM_EXTRA_EYE_COUNT,
      0,
      expansionEnd + EYE_HOLD_MS + EYE_INSERTION_STAGGER_MS,
    );

    return clearSequence;
  }, [animated, clearSequence, scheduleEyes]);

  const toggleEyes = () => {
    if (!isVisible) {
      return;
    }

    clearSequence();
    const targetCount =
      currentEyeCountRef.current === 0 ? MAXIMUM_EXTRA_EYE_COUNT : 0;
    animateEyes(targetCount);
  };

  const content = (
    <>
      <span className="font-brand-handwriting">My</span>
      <span className="font-brand">
        Mach
        <WordmarkI />
        {Array.from({ length: MAXIMUM_EXTRA_EYE_COUNT }, (_, index) => (
          <WordmarkI key={index} extra visible={index < extraEyeCount} />
        ))}
        nes
      </span>
    </>
  );

  const sharedClassName = cn(
    "brand-wordmark rounded-[14px] px-3 py-2 text-white",
    isVisible && "brand-wordmark--visible",
    className,
  );

  const wordmark = href ? (
    <Link href={href} aria-label="My Machines home" className={sharedClassName}>
      {content}
    </Link>
  ) : (
    <button
      type="button"
      aria-label="My Machines"
      className={sharedClassName}
      onClick={toggleEyes}
    >
      {content}
    </button>
  );

  if (heading) {
    return <h1 className="leading-none">{wordmark}</h1>;
  }

  return wordmark;
}

function WordmarkI({ extra = false, visible = true }: { extra?: boolean; visible?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "brand-wordmark-i",
        extra && "brand-wordmark-i--extra",
        extra && visible && "brand-wordmark-i--visible",
      )}
    >
      ı
      <span className="brand-wordmark-dot" />
    </span>
  );
}
