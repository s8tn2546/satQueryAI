import { useState } from 'react';

const METRIC_DATASETS = {
  NDVI: {
    title: 'NDVI Vegetation Index',
    unit: 'NDVI',
    delta: '+14.2%',
    driver: 'Seasonal vegetation regrowth & canopy expansion detected across T1 to T2 timeframe.',
    points: [
      { label: 'Jan 24', value: 0.42, metric: '0.42 NDVI', raw: 42 },
      { label: 'Mar 24', value: 0.58, metric: '0.58 NDVI', raw: 58 },
      { label: 'May 24', value: 0.76, metric: '0.76 NDVI', raw: 76 },
      { label: 'Jul 24', value: 0.84, metric: '0.84 NDVI', raw: 84 },
      { label: 'Sep 24', value: 0.71, metric: '0.71 NDVI', raw: 71 },
      { label: 'Nov 24', value: 0.65, metric: '0.65 NDVI', raw: 65 },
    ],
    min: 0.0,
    max: 1.0,
  },
  NDWI: {
    title: 'NDWI Water Index',
    unit: 'NDWI',
    delta: '-8.5%',
    driver: 'Minor surface water boundary contraction observed around coastal retention reservoir.',
    points: [
      { label: 'Jan 24', value: 0.62, metric: '0.62 NDWI', raw: 62 },
      { label: 'Mar 24', value: 0.55, metric: '0.55 NDWI', raw: 55 },
      { label: 'May 24', value: 0.48, metric: '0.48 NDWI', raw: 48 },
      { label: 'Jul 24', value: 0.52, metric: '0.52 NDWI', raw: 52 },
      { label: 'Sep 24', value: 0.57, metric: '0.57 NDWI', raw: 57 },
      { label: 'Nov 24', value: 0.54, metric: '0.54 NDWI', raw: 54 },
    ],
    min: 0.0,
    max: 1.0,
  },
  FOOTPRINT: {
    title: 'Built-up Area Footprint',
    unit: 'm²',
    delta: '+26.8%',
    driver: 'Rapid infrastructure development confirmed with 1,240 m² newly surfaced structural footprint.',
    points: [
      { label: 'Jan 24', value: 3400, metric: '3,400 m²', raw: 34 },
      { label: 'Mar 24', value: 3650, metric: '3,650 m²', raw: 39 },
      { label: 'May 24', value: 4100, metric: '4,100 m²', raw: 55 },
      { label: 'Jul 24', value: 4450, metric: '4,450 m²', raw: 72 },
      { label: 'Sep 24', value: 4580, metric: '4,580 m²', raw: 78 },
      { label: 'Nov 24', value: 4640, metric: '4,640 m²', raw: 82 },
    ],
    min: 3000,
    max: 5000,
  },
  SAR_SIGMA: {
    title: 'SAR Backscatter Intensity',
    unit: 'dB',
    delta: '+3.4 dB',
    driver: 'High metallic backscatter signature consistent with vehicle and container movement.',
    points: [
      { label: 'Jan 24', value: -14.2, metric: '-14.2 dB', raw: 30 },
      { label: 'Mar 24', value: -12.8, metric: '-12.8 dB', raw: 45 },
      { label: 'May 24', value: -10.5, metric: '-10.5 dB', raw: 68 },
      { label: 'Jul 24', value: -9.8, metric: '-9.8 dB', raw: 75 },
      { label: 'Sep 24', value: -11.1, metric: '-11.1 dB', raw: 60 },
      { label: 'Nov 24', value: -10.8, metric: '-10.8 dB', raw: 63 },
    ],
    min: -20,
    max: 0,
  },
};

export default function TrendChart({ data }) {
  const [selectedMetric, setSelectedMetric] = useState('NDVI');
  const [hoveredPoint, setHoveredPoint] = useState(null);

  const activeDataset = METRIC_DATASETS[selectedMetric] || METRIC_DATASETS.NDVI;
  const points = data || activeDataset.points;

  const rawValues = points.map(p => p.raw || p.value);
  const maxRaw = Math.max(...rawValues);
  const minRaw = Math.min(...rawValues);

  // Map values to 220x90 viewBox coordinates
  const coords = points.map((p, i) => {
    const val = p.raw || p.value;
    const x = 32 + (i / (points.length - 1)) * 170;
    const y = 72 - ((val - minRaw) / (maxRaw - minRaw || 1)) * 48;
    return { ...p, x, y };
  });

  const pathD = coords.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`;
  }, '');

  const areaD = `${pathD} L ${coords[coords.length - 1].x} 75 L ${coords[0].x} 75 Z`;

  return (
    <div className="trend-chart-card">
      {/* Metric Selector Pills */}
      <div className="trend-metric-selector">
        {Object.keys(METRIC_DATASETS).map((key) => (
          <button
            key={key}
            type="button"
            className={`trend-metric-btn ${selectedMetric === key ? 'active' : ''}`}
            onClick={() => { setSelectedMetric(key); setHoveredPoint(null); }}
          >
            {key}
          </button>
        ))}
      </div>

      <div className="trend-chart-header">
        <div>
          <span className="trend-chart-title">{activeDataset.title}</span>
          <span className="trend-chart-unit">({activeDataset.unit})</span>
        </div>
        <span className="trend-chart-badge">{activeDataset.delta}</span>
      </div>

      <div className="trend-chart-container">
        <svg viewBox="0 0 220 95" className="trend-svg">
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

          {/* Y Axis Grid lines & Scale Labels */}
          <line x1="28" y1="24" x2="204" y2="24" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
          <text x="24" y="26" fill="#64748B" fontSize="5.5" textAnchor="end">{activeDataset.max}</text>

          <line x1="28" y1="48" x2="204" y2="48" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
          <text x="24" y="50" fill="#64748B" fontSize="5.5" textAnchor="end">
            {((activeDataset.max + activeDataset.min) / 2).toFixed(1)}
          </text>

          <line x1="28" y1="72" x2="204" y2="72" stroke="rgba(255,255,255,0.12)" />
          <text x="24" y="74" fill="#64748B" fontSize="5.5" textAnchor="end">{activeDataset.min}</text>

          {/* Area Fill */}
          <path d={areaD} fill="url(#trendGrad)" />

          {/* Line Path */}
          <path d={pathD} fill="none" stroke="url(#lineGrad)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />

          {/* Data Points & X Axis Labels */}
          {coords.map((p, i) => (
            <g key={i} onMouseEnter={() => setHoveredPoint(p)} onMouseLeave={() => setHoveredPoint(null)}>
              <circle
                cx={p.x}
                cy={p.y}
                r={hoveredPoint?.label === p.label ? 4.8 : 3.2}
                fill="#060913"
                stroke={hoveredPoint?.label === p.label ? '#34D399' : '#6EB4FF'}
                strokeWidth="1.8"
                style={{ cursor: 'pointer', transition: 'r 0.15s, stroke 0.15s' }}
              />
              <text x={p.x} y="86" fill="#94A3B8" fontSize="5.5" textAnchor="middle">
                {p.label}
              </text>
            </g>
          ))}
        </svg>

        {hoveredPoint && (
          <div className="trend-tooltip">
            <strong>{hoveredPoint.label}</strong>: {hoveredPoint.metric}
          </div>
        )}
      </div>

      {/* Driver Narrative Card */}
      <div className="trend-driver-card">
        <span className="trend-driver-label">ANALYSIS DRIVER</span>
        <p className="trend-driver-text">{activeDataset.driver}</p>
      </div>
    </div>
  );
}
