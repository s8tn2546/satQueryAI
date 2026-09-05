export function BorderBeam({
  children,
  size = 1.5,
  duration = 3.1,
  borderRadius = 20,
  colorVariant = 'colorful',
  color,
  className = '',
  style = {},
}) {
  const resolvedSize = size === 'line' ? 1.5 : typeof size === 'number' ? size : 1.5;

  const gradient = color
    ? `linear-gradient(90deg, transparent, ${color}, transparent)`
    : colorVariant === 'colorful'
      ? 'conic-gradient(from 0deg, #ff6b6b, #feca57, #48dbfb, #ff9ff3, #54a0ff, #5f27cd, #ff6b6b)'
      : 'linear-gradient(90deg, transparent, #22d3ee, transparent)';

  return (
    <div
      className={`border-beam-wrapper ${className}`}
      style={{
        position: 'relative',
        display: 'inline-block',
        borderRadius,
        overflow: 'hidden',
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: `-${resolvedSize}px`,
          borderRadius: borderRadius + resolvedSize,
          padding: resolvedSize,
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            background: gradient,
            animation: `border-beam-spin ${duration}s linear infinite`,
          }}
        />
      </div>
      {children}
    </div>
  );
}

export default BorderBeam;
