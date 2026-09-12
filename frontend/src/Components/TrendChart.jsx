import { useState } from 'react';

export default function TrendChart({ data, onInvestigatePeriod }) {
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [selectedRange, setSelectedRange] = useState({ start: null, end: null });

  // Handle data from object or direct array
  const trendObj = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  const observations = Array.isArray(trendObj.observations)
    ? trendObj.observations
    : (Array.isArray(data) ? data : Array.isArray(data?.series) ? data.series : []);

  const metric = trendObj.metric || 'NDVI';
  const aoiName = trendObj.region || trendObj.aoiName || 'Selected AOI';
  const qualityCounts = trendObj.qualityCounts || {
    good: observations.filter(o => o.quality === 'GOOD' || !o.quality).length,
    warning: observations.filter(o => o.quality === 'WARNING').length,
    excluded: observations.filter(o => o.quality === 'EXCLUDED').length
  };

  const trendStats = trendObj.trendStats || {
    validObservationsCount: observations.filter(o => o.quality !== 'EXCLUDED' && typeof o.value === 'number').length,
    totalObservationsCount: observations.length,
    firstValue: observations[0]?.value ?? null,
    lastValue: observations[observations.length - 1]?.value ?? null,
    trendDirection: observations.length >= 3 ? 'Valid Trend' : 'Insufficient data',
    trendStatus: observations.length >= 3
      ? 'Valid trend calculated'
      : (observations.length === 2
        ? 'Temporal comparison available; insufficient observations for trend.'
        : 'Insufficient temporal observations.')
  };

  const anomalies = trendObj.anomalies || [];

  if (observations.length === 0) {
    return (
      <div className="trend-chart-card p-4 rounded-lg bg-slate-900/80 border border-slate-800 space-y-3">
        <div className="trend-chart-header flex items-center justify-between border-b border-slate-800 pb-2">
          <span className="text-xs font-bold uppercase tracking-wider text-blue-400">TIMELINE & MULTI-TEMPORAL MONITORING</span>
        </div>
        <p className="text-xs text-slate-400 py-4 text-center">Insufficient temporal observations.</p>
      </div>
    );
  }

  const validPoints = observations.filter(p => p.quality !== 'EXCLUDED' && typeof p.value === 'number');
  const maxVal = validPoints.length > 0 ? Math.max(...validPoints.map(p => p.value)) : 1;
  const minVal = validPoints.length > 0 ? Math.min(...validPoints.map(p => p.value)) : 0;

  const dateRangeStr = observations.length >= 2
    ? `${observations[0].date || observations[0].label} — ${observations[observations.length - 1].date || observations[observations.length - 1].label}`
    : (observations[0]?.date || observations[0]?.label || 'Single observation');

  // Map values to 200x85 viewBox
  const coords = observations.map((p, i) => {
    const label = String(p.date || p.label || `T${i + 1}`).slice(0, 10);
    const x = 20 + (i / (observations.length - 1 || 1)) * 160;
    const y = p.value !== null && Number.isFinite(p.value)
      ? 70 - ((p.value - minVal) / (maxVal - minVal || 1)) * 50
      : 70;
    return { ...p, label, x, y, idx: i };
  });

  const validCoords = coords.filter(c => c.quality !== 'EXCLUDED' && typeof c.value === 'number');
  const pathD = validCoords.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`;
  }, '');

  const areaD = validCoords.length > 0
    ? `${pathD} L ${validCoords[validCoords.length - 1].x} 75 L ${validCoords[0].x} 75 Z`
    : '';

  const handlePointClick = (pt) => {
    setSelectedPoint(pt);
    if (!selectedRange.start || (selectedRange.start && selectedRange.end)) {
      setSelectedRange({ start: pt, end: null });
    } else if (selectedRange.start && !selectedRange.end) {
      if (pt.idx > selectedRange.start.idx) {
        setSelectedRange({ start: selectedRange.start, end: pt });
      } else {
        setSelectedRange({ start: pt, end: selectedRange.start });
      }
    }
  };

  return (
    <div className="trend-chart-card p-4 rounded-lg bg-slate-900/90 border border-slate-800 space-y-4">
      {/* Workspace Header */}
      <div className="trend-chart-header flex items-start justify-between border-b border-slate-800/80 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-blue-400">MULTI-TEMPORAL MONITORING</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-950 text-blue-300 border border-blue-800">
              {metric}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            AOI: <strong className="text-slate-200">{aoiName}</strong> &bull; Date Range: <span className="font-mono text-slate-300">{dateRangeStr}</span>
          </p>
        </div>

        {/* Quality Badges */}
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/60 text-emerald-300" title="Valid observations">
            {qualityCounts.good} Good
          </span>
          {qualityCounts.warning > 0 && (
            <span className="px-2 py-0.5 rounded bg-amber-950/60 border border-amber-800/60 text-amber-300" title="Partial quality observations">
              {qualityCounts.warning} Warning
            </span>
          )}
          {qualityCounts.excluded > 0 && (
            <span className="px-2 py-0.5 rounded bg-rose-950/60 border border-rose-800/60 text-rose-300" title="Excluded observations">
              {qualityCounts.excluded} Excluded
            </span>
          )}
        </div>
      </div>

      {/* Trend Direction & Status Summary */}
      <div className="p-3 rounded bg-slate-950/70 border border-slate-800/60 flex items-center justify-between text-xs">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Trend Direction:</span>
            <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
              trendStats.trendDirection === 'Increasing' ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/50' :
              trendStats.trendDirection === 'Decreasing' ? 'bg-rose-900/60 text-rose-300 border border-rose-700/50' :
              trendStats.trendDirection === 'Stable' ? 'bg-blue-900/60 text-blue-300 border border-blue-700/50' :
              'bg-slate-800 text-slate-300 border border-slate-700'
            }`}>
              {trendStats.trendDirection}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1 font-mono">{trendStats.trendStatus}</p>
        </div>

        {trendStats.validObservationsCount >= 3 && (
          <div className="text-right space-y-0.5 font-mono text-[11px]">
            {typeof trendStats.slope === 'number' && (
              <div className="text-slate-300">
                Slope: <strong className="text-blue-300">{trendStats.slope > 0 ? '+' : ''}{trendStats.slope.toFixed(4)}</strong>/step
              </div>
            )}
            {typeof trendStats.absoluteChange === 'number' && (
              <div className="text-slate-400 text-[10px]">
                Delta: <span className={trendStats.absoluteChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {trendStats.absoluteChange >= 0 ? '+' : ''}{trendStats.absoluteChange.toFixed(3)}
                  {typeof trendStats.relativeChange === 'number' && ` (${trendStats.relativeChange >= 0 ? '+' : ''}${trendStats.relativeChange.toFixed(1)}%)`}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* SVG Time-Series Chart */}
      <div className="trend-chart-container relative rounded bg-slate-950/90 border border-slate-800/80 p-2">
        <svg viewBox="0 0 200 90" className="trend-svg w-full h-auto">
          <defs>
            <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3B7DDD" stopOpacity="0.4" />
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
          {areaD && <path d={areaD} fill="url(#trendGrad)" />}

          {/* Line Path */}
          {pathD && <path d={pathD} fill="none" stroke="url(#lineGrad)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}

          {/* Data Points */}
          {coords.map((p, i) => {
            const isSelected = selectedRange.start?.idx === i || selectedRange.end?.idx === i || selectedPoint?.idx === i;
            const isExcluded = p.quality === 'EXCLUDED';
            const isWarning = p.quality === 'WARNING';
            const fillColor = isExcluded ? '#F43F5E' : isWarning ? '#F59E0B' : (isSelected ? '#3B7DDD' : '#060913');
            const strokeColor = isExcluded ? '#FDA4AF' : isWarning ? '#FCD34D' : '#6EB4FF';

            return (
              <g key={i} onMouseEnter={() => setHoveredPoint(p)} onMouseLeave={() => setHoveredPoint(null)} onClick={() => handlePointClick(p)}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isSelected ? 5.5 : hoveredPoint?.idx === i ? 4.5 : 3.2}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={isSelected ? '2.5' : '1.8'}
                  style={{ cursor: 'pointer', transition: 'r 0.15s' }}
                />
                <text x={p.x} y="84" fill="#94A3B8" fontSize="5.5" textAnchor="middle">
                  {p.label}
                </text>
              </g>
            );
          })}
        </svg>

        {hoveredPoint && (
          <div className="trend-tooltip absolute top-2 right-2 bg-slate-900/95 border border-slate-700 text-white p-2 rounded shadow-lg text-[10px] space-y-0.5 z-10">
            <div className="font-bold text-blue-300">{hoveredPoint.label}</div>
            <div>Value: <span className="font-mono text-emerald-300">{hoveredPoint.value !== null ? hoveredPoint.value.toFixed(3) : 'Excluded'}</span></div>
            <div>Quality: <span className={`font-semibold ${hoveredPoint.quality === 'GOOD' ? 'text-emerald-400' : hoveredPoint.quality === 'WARNING' ? 'text-amber-400' : 'text-rose-400'}`}>{hoveredPoint.quality || 'GOOD'}</span></div>
            {hoveredPoint.validPercent && <div>Coverage: <span className="font-mono">{hoveredPoint.validPercent}%</span></div>}
          </div>
        )}
      </div>

      {/* Inspectable Point Detail Drawer */}
      {selectedPoint && (
        <div className="p-3 bg-slate-950/80 border border-slate-800 rounded text-xs space-y-1.5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1">
            <span className="font-semibold text-slate-200">Observation Inspection: <span className="text-blue-400 font-mono">{selectedPoint.label}</span></span>
            <button onClick={() => setSelectedPoint(null)} className="text-slate-400 hover:text-white text-[10px]">Close</button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>Metric ({metric}): <strong className="text-emerald-400 font-mono">{selectedPoint.value !== null ? selectedPoint.value.toFixed(4) : 'N/A'}</strong></div>
            <div>Quality Status: <strong className={selectedPoint.quality === 'GOOD' ? 'text-emerald-400' : selectedPoint.quality === 'WARNING' ? 'text-amber-400' : 'text-rose-400'}>{selectedPoint.quality || 'GOOD'}</strong></div>
            <div>Source / Sensor: <span className="text-slate-300">{selectedPoint.source || 'Sentinel-2'} ({selectedPoint.sensor || 'MSI'})</span></div>
            <div>Valid Coverage: <span className="text-slate-300">{selectedPoint.validPercent || 100}%</span></div>
            {selectedPoint.tileId && <div className="col-span-2 text-slate-400 font-mono text-[10px]">Tile ID: {selectedPoint.tileId}</div>}
            {selectedPoint.qualityReason && <div className="col-span-2 text-rose-300 text-[10px]">Reason: {selectedPoint.qualityReason}</div>}
          </div>
        </div>
      )}

      {/* Anomalies & Events */}
      {anomalies.length > 0 && (
        <div className="p-3 bg-slate-950/90 border border-amber-500/30 rounded space-y-2 text-xs">
          <div className="flex items-center justify-between text-amber-300 font-semibold border-b border-amber-500/20 pb-1">
            <span className="flex items-center gap-1.5 text-[11px]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Detected Temporal Anomalies ({anomalies.length})
            </span>
          </div>

          <div className="space-y-2">
            {anomalies.map((anom, idx) => (
              <div key={idx} className="p-2 rounded bg-amber-950/20 border border-amber-800/40 text-[11px] space-y-1">
                <div className="flex items-center justify-between text-amber-200 font-medium">
                  <span>{anom.type} on <span className="font-mono text-white">{anom.date}</span></span>
                  <span className="font-mono text-[10px] text-amber-400">Deviation: {anom.deviation > 0 ? '+' : ''}{anom.deviation}</span>
                </div>
                <p className="text-slate-300 text-[10px]">{anom.description}</p>
                {onInvestigatePeriod && anom.period && (
                  <div className="pt-1 flex justify-end">
                    <button
                      onClick={() => onInvestigatePeriod({ label: anom.period.start }, { label: anom.period.end })}
                      className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded text-[10px] transition-colors"
                    >
                      Investigate period ({anom.period.start} $\to$ {anom.period.end})
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual Period Selection for Investigation */}
      {selectedRange.start && selectedRange.end && (
        <div className="p-2.5 bg-blue-950/50 border border-blue-500/40 rounded flex items-center justify-between text-xs">
          <span className="text-slate-300">
            Selected Period: <strong className="text-blue-300 font-mono">{selectedRange.start.label}</strong> $\to$ <strong className="text-blue-300 font-mono">{selectedRange.end.label}</strong>
          </span>
          {onInvestigatePeriod && (
            <button
              onClick={() => onInvestigatePeriod(selectedRange.start, selectedRange.end)}
              className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded text-[11px] transition-colors shadow"
            >
              Investigate Period ($T_1 \to T_2$)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
