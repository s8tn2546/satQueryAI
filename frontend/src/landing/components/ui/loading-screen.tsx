import React, { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface LoadingScreenProps {
  onComplete?: () => void;
  duration?: number;
  className?: string;
}

const WELCOME_TEXT = "WELCOME";

const LoadingScreen: React.FC<LoadingScreenProps> = ({
  onComplete,
  duration = 4000,
  className,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [typed, setTyped] = useState(0);

  // Typewriter: reveal one character at a time
  useEffect(() => {
    const interval = window.setInterval(() => {
      setTyped((t) => {
        if (t >= WELCOME_TEXT.length) {
          window.clearInterval(interval);
          return t;
        }
        return t + 1;
      });
    }, 360);
    return () => window.clearInterval(interval);
  }, []);

  // Auto-dismiss after duration
  useEffect(() => {
    const timeout = setTimeout(() => {
      onComplete?.();
    }, duration);
    return () => clearTimeout(timeout);
  }, [duration, onComplete]);

  // Play the background loop at 3x speed
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = 3;
    }
  }, []);

  return (
    <div
      className={cn(
        "fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background overflow-hidden",
        className
      )}
    >
      {/* Fullscreen background video at 3x speed */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        src="/loading-welcome.mp4"
        poster="/loading-earth-poster.jpg"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
      />

      {/* Legibility overlay */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(2,6,23,0.15) 0%, rgba(2,6,23,0.55) 100%)",
        }}
      />

      {/* Glassy, glowing WELCOME typing itself out */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-end justify-center pb-[8vh]">
        <h1 className="welcome-glow relative font-medium text-7xl sm:text-8xl md:text-9xl tracking-[0.06em]">
          <span className="welcome-glass">{WELCOME_TEXT.slice(0, typed)}</span>
          <span className="welcome-caret" aria-hidden="true" />
        </h1>
      </div>
    </div>
  );
};

export default LoadingScreen;