import React, { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface LoadingScreenProps {
  onComplete?: () => void;
  duration?: number;
  className?: string;
}

const LoadingScreen: React.FC<LoadingScreenProps> = ({
  onComplete,
  duration = 4000,
  className,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Auto-dismiss after duration
  useEffect(() => {
    const timeout = setTimeout(() => {
      onComplete?.();
    }, duration);
    return () => clearTimeout(timeout);
  }, [duration, onComplete]);

  // Play the loop at a slightly faster speed
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = 1.25;
    }
  }, []);

  return (
    <div
      className={cn(
        "fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background overflow-hidden",
        className
      )}
    >
      {/* Fullscreen earth-in-space video background */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        src="/loading-earth.mp4"
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
            "linear-gradient(to bottom, rgba(2,6,23,0.25) 0%, rgba(2,6,23,0.15) 40%, rgba(2,6,23,0.65) 100%)",
        }}
      />
    </div>
  );
};

export default LoadingScreen;