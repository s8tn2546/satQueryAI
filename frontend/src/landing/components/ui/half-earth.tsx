import React from "react";

/**
 * A large rotating earth anchored at the bottom of the login page.
 * Its top arc crests at ~55% of the viewport height and spans most of the
 * width, keeping the globe comfortably framed (not over-zoomed). The globe
 * enters by smoothly pulling back (scale about the crest) from the landing
 * page's zoomed-in close-up, then rotates seamlessly using a high-resolution
 * equirectangular texture. Brightness is kept low so it stays a backdrop.
 */
const HalfEarth: React.FC = () => {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div
        className="absolute left-1/2"
        style={{
          width: "100vmax",
          height: "100vmax",
          top: "calc(55vh + 50vmax)",
          transform: "translate(-50%, -50%)",
          transformOrigin: "50% 0%",
          willChange: "transform, opacity",
          animation: "half-earth-enter 1.6s cubic-bezier(0.22, 1, 0.36, 1) both",
        }}
      >
        {/* Earth globe */}
        <div
          className="absolute inset-0 rounded-full overflow-hidden"
          style={{
            backgroundImage: "url('/earth-blue-marble.jpg')",
            backgroundSize: "cover",
            backgroundPosition: "-50vmax 50%",
            animation: "half-earth-rotate 28s linear infinite",
            filter: "brightness(0.6) contrast(1.05) saturate(0.9)",
            boxShadow:
              "0 0 30px rgba(255,255,255,0.08), -6px 0 10px #c3f4ff inset, 20px 3px 28px #000 inset, -32px -3px 42px #c3f4ff66 inset, 260px 0 50px #00000066 inset, 160px 0 42px #000000aa inset",
          }}
        />
        {/* Dark vignette to keep the earth dim behind the login card */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 50% 40%, rgba(2,6,23,0.3), rgba(2,6,23,0.55) 70%)",
          }}
        />
        {/* Atmospheric horizon line along the crest of the globe */}
        <div
          className="absolute rounded-full overflow-hidden"
          style={{
            inset: "-2.5% 0 auto 0",
            height: "5%",
            background:
              "radial-gradient(ellipse 50% 120% at 50% 0%, rgba(120,190,255,0.25), rgba(80,150,255,0.08) 45%, transparent 70%)",
            filter: "blur(6px)",
          }}
        />
      </div>
    </div>
  );
};

export default HalfEarth;