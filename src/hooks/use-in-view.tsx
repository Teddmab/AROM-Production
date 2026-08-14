import { useEffect, useRef, useState } from "react";

/**
 * Tracks whether an element is in the viewport, toggling back to false when
 * it scrolls back out — the animation triggered off this is meant to
 * reverse on scroll-up, not just play once. Falls back to "always visible"
 * under prefers-reduced-motion so nothing depends on motion to be legible.
 */
export function useInView<T extends HTMLElement>(threshold = 0.35) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold,
      rootMargin: "0px 0px -10% 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, inView };
}
