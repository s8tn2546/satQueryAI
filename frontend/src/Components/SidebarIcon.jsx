export default function SidebarIcon({ size = 26, className = '', showTile = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={showTile ? "0 0 512 512" : "36 91 440 330"}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {showTile && <rect width="512" height="512" rx="112" ry="112" fill="#0A0E16" />}
      <rect x="216" y="166" width="180" height="36" rx="18" ry="18" fill="currentColor" />
      <rect x="116" y="238" width="280" height="36" rx="18" ry="18" fill="currentColor" />
      <rect x="116" y="310" width="180" height="36" rx="18" ry="18" fill="currentColor" />
    </svg>
  );
}
