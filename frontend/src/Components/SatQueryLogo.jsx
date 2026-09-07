export default function SatQueryLogo({ size = 32, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <filter id="logoGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#8FC5FF" />
          <stop offset="100%" stopColor="#3B7DDD" />
        </linearGradient>
      </defs>

      <g filter="url(#logoGlow)">
        {/* Back Orbit Ring Arc */}
        <path
          d="M 100 210 A 185 64 -22 0 1 412 240"
          fill="none"
          stroke="url(#lineGrad)"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.45"
        />

        {/* Globe Sphere Outline - Transparent Fill */}
        <circle
          cx="256"
          cy="240"
          r="110"
          fill="none"
          stroke="url(#lineGrad)"
          strokeWidth="4.5"
        />

        {/* Lat/Lon Curvature Lines */}
        <path
          d="M 146 240 A 110 110 0 0 0 366 240"
          fill="none"
          stroke="#6EB4FF"
          strokeWidth="2.5"
          opacity="0.5"
        />
        <path
          d="M 166 188 A 110 60 0 0 0 346 188"
          fill="none"
          stroke="#6EB4FF"
          strokeWidth="2"
          opacity="0.4"
        />
        <path
          d="M 166 292 A 110 60 0 0 0 346 292"
          fill="none"
          stroke="#6EB4FF"
          strokeWidth="2"
          opacity="0.4"
        />
        <path
          d="M 256 130 A 110 110 0 0 1 256 350"
          fill="none"
          stroke="#6EB4FF"
          strokeWidth="2.5"
          opacity="0.5"
        />

        {/* Abstract Continental Landmass Line Art */}
        <path
          d="M 195 180 Q 218 165 240 182 T 262 200"
          fill="none"
          stroke="#8FC5FF"
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.8"
        />
        <path
          d="M 225 232 Q 255 225 277 248 T 262 292"
          fill="none"
          stroke="#6EB4FF"
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.75"
        />
        <path
          d="M 292 188 Q 330 180 345 210"
          fill="none"
          stroke="#8FC5FF"
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.8"
        />

        {/* Front Orbit Ring Arc */}
        <path
          d="M 412 240 A 185 64 -22 0 1 100 210"
          fill="none"
          stroke="url(#lineGrad)"
          strokeWidth="5"
          strokeLinecap="round"
        />

        {/* Orbiting Satellite Spark Dot */}
        <circle cx="395" cy="254" r="7" fill="#E8ECF1" />
      </g>
    </svg>
  );
}
