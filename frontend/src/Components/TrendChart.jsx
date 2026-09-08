import { useState } from 'react';

export default function TrendChart({ data }) {
  const [hoveredPoint, setHoveredPoint] = useState(null);

const points = Array.isArray(data)
    ? data
    : Array.isArray(data?.series) ? data.series : [];

  if (points.length === 0) {
    return (
      <div className="trend-chart-card">
        <div className="trend-chart-header">
          <span className="trend-chart-title">TIMELINE & TREND ANALYSIS</span>
        </div>
        <p className="results-empty-state">No trend data available for this query yet.</p>
      </div>
    );
  }

  const maxVal = Math.max(...points.map(p => p.value));
  const minVal = Math.min(...points.map(p => p.value));

  // Map values to 200x80 viewBox
  const coords = points.map((p, i) => {
    const x = 20 + (i / (points.length - 1)) * 160;
    const y = 70 - ((p.value - minVal) / (maxVal - minVal || 1)) * 50;
    return { ...p, x, y };
  });

  const pathD = coords.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`;
  }, '');

  const areaD = `${pathD} L ${coords[coords.length - 1].x} 75 L ${coords[0].x} 75 Z`;

  const delta = maxVal - minVal;

  return (
    <div className="trend-chart-card">
      <div className="trend-chart-header">
        <span className="trend-chart-title">TIMELINE & TREND ANALYSIS</span>
        {points.length > 1 && delta !== 0 && (
          <span className={`trend-chart-badge ${delta > 0 ? 'delta-up' : 'delta-down'}`}>
            {delta > 0 ? '+' : ''}{delta.toFixed(2)} Delta
          </span>
        )}
      </div>

      <div className="trend-chart-container">
        <svg viewBox="0 0 200 85" className="trend-svg">
          <defs>
            <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3B7DDD" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#3B7DDD" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#6EB4FF" />
              <stop offset="100%" stopColor="#34D399" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line x1="20" y1="20" x2="180" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
          <line x1="20" y1="45" x2="180" y2="45" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
          <line x1="20" y1="70" x2="180" y2="70" stroke="rgba(255,255,255,0.08)" />

          {/* Area Fill */}
          <path d={areaD} fill="url(#trendGrad)" />

          {/* Line Path */}
          <path d={pathD} fill="none" stroke="url(#lineGrad)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />

          {/* Data Points */}
          {coords.map((p, i) => (
            <g key={i} onMouseEnter={() => setHoveredPoint(p)} onMouseLeave={() => setHoveredPoint(null)}>
              <circle
                cx={p.x}
                cy={p.y}
                r={hoveredPoint?.label === p.label ? 4.5 : 3}
                fill="#060913"
                stroke="#6EB4FF"
                strokeWidth="1.8"
                style={{ cursor: 'pointer', transition: 'r 0.15s' }}
              />
              <text x={p.x} y="82" fill="#94A3B8" fontSize="6" textAnchor="middle">
                {p.label}
              </text>
            </g>
          ))}
        </svg>

        {hoveredPoint && (
          <div className="trend-tooltip">
            <strong>{hoveredPoint.label}</strong>: {hoveredPoint.metric || hoveredPoint.value}
          </div>
        )}
      </div>
    </div>
  );
}