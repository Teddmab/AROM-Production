import type { ReactNode } from "react";
import { useInView } from "@/hooks/use-in-view";

/**
 * Fades/slides content in as it enters the viewport, and reverses back to
 * its hidden state when it scrolls back out, so the motion reads as a
 * response to scroll direction rather than a one-shot page-load effect.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-700 ease-out ${className}`}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(24px)",
        transitionDelay: inView ? `${delay}ms` : "0ms",
      }}
    >
      {children}
    </div>
  );
}
