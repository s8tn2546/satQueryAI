import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Globe from "@/components/ui/globe";
import { cn } from "@/lib/utils";

gsap.registerPlugin(ScrollTrigger);

// Reusable ScrollGlobe component following shadcn/ui patterns
interface ScrollGlobeProps {
  sections: {
    id: string;
    badge?: string;
    title: string;
    subtitle?: string;
    description: string;
    align?: "left" | "center" | "right";
    features?: { title: string; description: string }[];
    actions?: { label: string; variant: "primary" | "secondary" | "accent"; onClick?: () => void }[];
  }[];
  globeConfig?: {
    positions: {
      top: string;
      left: string;
      scale: number;
    }[];
  };
  className?: string;
}

export interface ScrollGlobeHandle {
  /**
   * Animates the earth gliding downward to the bottom of the viewport,
   * then calls the completion callback (used to navigate to the login page).
   */
  animateExit: (onComplete: () => void) => void;
}

const defaultGlobeConfig = {
  positions: [
    { top: "50%", left: "68%", scale: 1.5 },   // Hero: Right side, balanced
    { top: "32%", left: "30%", scale: 1.25 },  // Innovation: Top-left, subtle
    { top: "15%", left: "78%", scale: 1.7 },   // Discovery: Right side, medium
    { top: "50%", left: "50%", scale: 3.4 },   // Final: Covers the full screen
  ],
};

// Parse percentage string to number
const parsePercent = (str: string): number => parseFloat(str.replace("%", ""));

const ScrollGlobe = forwardRef<ScrollGlobeHandle, ScrollGlobeProps>(function ScrollGlobe(
  { sections, globeConfig = defaultGlobeConfig, className },
  ref
) {
  const [scrollProgress, setScrollProgress] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<HTMLDivElement>(null);
  const animationFrameId = useRef<number | undefined>(undefined);
  const exitAnimationRunning = useRef(false);

  // Pre-calculate positions for performance
  const calculatedPositions = useMemo(() => {
    return globeConfig.positions.map((pos) => ({
      top: parsePercent(pos.top),
      left: parsePercent(pos.left),
      scale: pos.scale,
    }));
  }, [globeConfig.positions]);

  // Place the globe at its hero position before first paint
  useLayoutEffect(() => {
    if (!globeRef.current) return;
    const pos = calculatedPositions[0];
    gsap.set(globeRef.current, {
      xPercent: -50,
      yPercent: -50,
      left: `${pos.left}%`,
      top: `${pos.top}%`,
      scale: pos.scale,
    });
  }, [calculatedPositions]);

  // Interpolate the globe across waypoints continuously, driven by scroll progress.
  // The GSAP tween with overwrite makes the model glide slowly and smoothly,
  // following the scroll speed instead of snapping between sections.
  const updateScrollPosition = useCallback(() => {
    const scrollTop = window.pageYOffset;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = Math.min(Math.max(scrollTop / docHeight, 0), 1);

    setScrollProgress(progress);

    if (globeRef.current && calculatedPositions.length > 1 && !exitAnimationRunning.current) {
      const count = calculatedPositions.length;
      const scaled = progress * (count - 1);
      const index = Math.min(Math.floor(scaled), count - 1);
      const frac = Math.min(Math.max(scaled - index, 0), 1);
      const from = calculatedPositions[index];
      const to = calculatedPositions[Math.min(index + 1, count - 1)];
      const top = from.top + (to.top - from.top) * frac;
      const left = from.left + (to.left - from.left) * frac;
      const scale = from.scale + (to.scale - from.scale) * frac;

      gsap.to(globeRef.current, {
        left: `${left}%`,
        top: `${top}%`,
        scale,
        duration: 0.9,
        ease: "power2.out",
        overwrite: "auto",
      });
    }
  }, [calculatedPositions]);

  // Throttled scroll handler with RAF
  useEffect(() => {
    let ticking = false;

    const handleScroll = () => {
      if (!ticking) {
        animationFrameId.current = requestAnimationFrame(() => {
          updateScrollPosition();
          ticking = false;
        });
        ticking = true;
      }
    };

    // Use passive listeners and immediate execution
    window.addEventListener("scroll", handleScroll, { passive: true });
    const initialFrame = requestAnimationFrame(updateScrollPosition); // Initial call

    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
      cancelAnimationFrame(initialFrame);
    };
  }, [updateScrollPosition]);

  // Exit animation: earth glides downward to the bottom edge of the viewport,
  // then triggers the completion callback (navigate to login).
  useImperativeHandle(
    ref,
    () => ({
      animateExit(onComplete) {
        if (!globeRef.current || exitAnimationRunning.current) return;
        exitAnimationRunning.current = true;

        const lastPos = calculatedPositions[calculatedPositions.length - 1];

        gsap.to(globeRef.current, {
          left: `${lastPos.left}%`,
          top: "115%",
          scale: lastPos.scale,
          xPercent: -50,
          yPercent: -50,
          duration: 1.5,
          ease: "power2.inOut",
          overwrite: "auto",
          onComplete: () => {
            exitAnimationRunning.current = false;
            onComplete?.();
          },
        });
      },
    }),
    [calculatedPositions]
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full max-w-screen overflow-x-hidden min-h-screen bg-background text-foreground satquery-sky",
        className
      )}
      style={{
        backgroundImage:
          "linear-gradient(to bottom, rgba(2,6,23,0.72) 0%, rgba(2,6,23,0.88) 100%), url(\"/landing-bg.jpg\")",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* Progress Bar */}
      <div className="fixed top-0 left-0 w-full h-0.5 bg-gradient-to-r from-border/20 via-border/40 to-border/20 z-50">
        <div
          className="h-full bg-gradient-to-r from-primary via-primary-foreground to-primary will-change-transform shadow-sm"
          style={{
            transform: `scaleX(${scrollProgress})`,
            transformOrigin: "left center",
            transition: "transform 0.15s ease-out",
            filter: "drop-shadow(0 0 2px rgba(0, 0, 0, 0.3))",
          }}
        />
      </div>

      {/* CSS Earth globe with responsive scaling - positioned by GSAP only */}
      <div
        ref={globeRef}
        className="fixed z-10 pointer-events-none will-change-transform"
        style={{
          filter: `drop-shadow(0 0 40px rgba(47,125,255,0.25))`,
          transition: "filter 0.9s ease",
        }}
      >
        <div className="h-[26rem] w-[26rem] sm:h-[32rem] sm:w-[32rem] lg:h-[40rem] lg:w-[40rem] scale-[1.15]">
          <Globe scrollRotation={scrollProgress} />
        </div>
      </div>

      {/* Dynamic sections - fully responsive */}
      {sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className={cn(
            "relative min-h-screen flex flex-col justify-center px-4 sm:px-6 md:px-8 lg:px-12 z-20 py-12 sm:py-16 lg:py-20",
            "w-full max-w-full overflow-hidden",
            section.align === "center" && "items-center text-center",
            section.align === "right" && "items-end text-right",
            section.align !== "center" && section.align !== "right" && "items-start text-left"
          )}
        >
          <div
            className={cn(
              "w-full will-change-transform transition-all duration-700",
              "opacity-100 translate-y-0",
              section.id === "hero"
                ? "max-w-md sm:max-w-lg md:max-w-2xl lg:max-w-3xl xl:max-w-4xl pr-0 lg:pr-24 xl:pr-36"
                : "max-w-sm sm:max-w-lg md:max-w-2xl lg:max-w-4xl xl:max-w-5xl"
            )}
          >
            <h1
              className={cn(
                "font-thin uppercase tracking-[0.06em] mb-6 sm:mb-8 leading-[1.1] text-base sm:text-2lg md:text-3xl lg:text-4xl xl:text-5xl 2xl:text-6xl"
              )}
            >
              {section.subtitle ? (
                <div className="space-y-1 sm:space-y-2">
                  <div className="bg-gradient-to-r from-foreground to-foreground/80 bg-clip-text text-transparent">
                    {section.title}
                  </div>
                  <div className="text-muted-foreground/90 text-[0.6em] sm:text-[0.7em] font-light tracking-wider">
                    {section.subtitle}
                  </div>
                </div>
              ) : (
                <div className="bg-gradient-to-r from-foreground via-foreground to-foreground/80 bg-clip-text text-transparent">
                  {section.title}
                </div>
              )}
            </h1>

            <div
              className={cn(
                "text-muted-foreground/80 leading-relaxed mb-8 sm:mb-10 text-base sm:text-lg lg:text-xl font-light",
                section.align === "center" ? "max-w-full mx-auto text-center" : "max-w-full"
              )}
            >
              <p className="mb-3 sm:mb-4">{section.description}</p>
            </div>

            {/* Enhanced Features - Responsive grid */}
            {section.features && (
              <div className="grid gap-3 sm:gap-4 mb-8 sm:mb-10">
                {section.features.map((feature, featureIndex) => (
                  <div
                    key={feature.title}
                    className={cn(
                      "group p-4 sm:p-5 lg:p-6 rounded-lg sm:rounded-xl border bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300 hover:shadow-lg hover:shadow-primary/10",
                      "hover:border-primary/40 hover:-translate-y-1"
                    )}
                    style={{ animationDelay: `${featureIndex * 0.1}s` }}
                  >
                    <div className="flex items-start gap-3 sm:gap-4">
                      <div className="w-1.5 sm:w-2 h-1.5 sm:h-2 rounded-full bg-primary mt-1.5 sm:mt-2 group-hover:bg-primary-foreground transition-colors flex-shrink-0" />
                      <div className="flex-1 space-y-1.5 sm:space-y-2 min-w-0">
                        <h3 className="font-semibold text-card-foreground text-base sm:text-lg">{feature.title}</h3>
                        <p className="text-muted-foreground/80 leading-relaxed text-sm sm:text-base">{feature.description}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Enhanced Actions - Responsive buttons */}
            {section.actions && (
              <div
                className={cn(
                  "flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4",
                  section.align === "center" && "justify-center",
                  section.align === "right" && "justify-end",
                  (!section.align || section.align === "left") && "justify-start"
                )}
              >
                {section.actions.map((action, actionIndex) => (
                  <button
                    key={action.label}
                    onClick={action.onClick}
                    className={cn(
                      "group relative inline-flex items-center gap-2.5 px-6 sm:px-8 py-3 sm:py-4 rounded-full font-medium transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] text-sm sm:text-base",
                      "backdrop-blur-md border border-white/20 bg-white/10 text-foreground",
                      "shadow-[0_8px_32px_rgba(0,0,0,0.15)] hover:bg-white/20 hover:shadow-[0_8px_32px_rgba(0,0,0,0.25)]",
                      "focus:outline-none focus:ring-2 focus:ring-white/30 w-full sm:w-auto",
                      action.variant === "accent" &&
                        "border-white/40 bg-white/15 shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_8px_32px_rgba(255,255,255,0.18)] hover:bg-white/25 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.2),0_8px_40px_rgba(255,255,255,0.3)]"
                    )}
                    style={{ animationDelay: `${actionIndex * 0.1 + 0.2}s` }}
                  >
                    <span className="relative z-10">{action.label}</span>
                    {action.variant === "accent" && (
                      <svg
                        className="relative z-10 w-4 h-4 transition-transform duration-300 group-hover:translate-x-0.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12h14" />
                        <path d="m12 5 7 7-7 7" />
                      </svg>
                    )}
                    <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/30 to-white/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                    {action.variant === "accent" && (
                      <div className="absolute inset-0 rounded-full bg-white/10 animate-pulse pointer-events-none" />
                    )}
                    <div className="absolute -top-12 left-1/4 w-24 h-24 bg-white/10 rounded-full blur-2xl opacity-0 group-hover:opacity-60 transition-opacity duration-500 pointer-events-none" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
});

export default ScrollGlobe;