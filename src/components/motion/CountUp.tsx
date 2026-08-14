import { useEffect, useRef, useState } from "react";
import { useInView } from "@/hooks/use-in-view";

const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

/**
 * Counts a number up to `value` while it's in view, and drops back to 0
 * when scrolled away so the count-up replays the next time it re-enters
 * (mirrors <Reveal>'s reverse-on-scroll-up behavior for the same sections).
 */
export function CountUp({
  value,
  duration = 900,
  format = (n) => Math.round(n).toLocaleString("fr-FR"),
  className = "",
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const [display, setDisplay] = useState(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(value);
      return;
    }

    if (frame.current) cancelAnimationFrame(frame.current);

    if (!inView) {
      setDisplay(0);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setDisplay(value * easeOutQuint(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [inView, value, duration]);

  return (
    <span ref={ref} className={className}>
      {format(display)}
    </span>
  );
}
