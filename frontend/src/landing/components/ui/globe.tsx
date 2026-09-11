import React, { useEffect, useRef } from "react";

interface GlobeProps {
  /**
   * Scroll progress (0..1) that drives the earth's rotation.
   * Full page scroll = ~1.6 rotations for a slightly faster spin.
   */
  scrollRotation?: number;
}

const Globe: React.FC<GlobeProps> = ({ scrollRotation = 0 }) => {
  const earthRef = useRef<HTMLDivElement>(null);
  const phase = useRef(0);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      phase.current += 0.4;
      if (earthRef.current) {
        // The 2:1 equirectangular texture renders 500px wide on the 250px
        // globe, so a full seamless revolution shifts background-position
        // by 500px.
        earthRef.current.style.backgroundPosition = `${(scrollRotation * 800 + phase.current) % 500}px 0`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [scrollRotation]);

  return (
    <>
      <div className="flex h-full w-full items-center justify-center">
        <div className="relative h-[250px] w-[250px]">
          {/* Earth */}
          <div
            ref={earthRef}
            className="absolute inset-0 rounded-full overflow-hidden shadow-[0_0_20px_rgba(255,255,255,0.2),-5px_0_8px_#c3f4ff_inset,15px_2px_25px_#000_inset,-24px_-2px_34px_#c3f4ff99_inset,250px_0_44px_#00000066_inset,150px_0_38px_#000000aa_inset]"
            style={{
              backgroundImage: "url('/earth-blue-marble.jpg')",
              backgroundSize: "cover",
              backgroundPosition: "0 0",
            }}
          />
        </div>
      </div>
    </>
  );
};

export default Globe;