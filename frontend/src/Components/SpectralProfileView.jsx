import { useState } from 'react';

export default function SpectralProfileView({ profile }) {
  const [activeTab, setActiveTab] = useState('chart');

  if (!profile || !Array.isArray(profile.bands) || profile.bands.length === 0) {
    return (
      <div className="spectral-profile-card p-4 rounded-lg bg-slate-900/80 border border-slate-800 text-xs text-slate-400">
        No spectral profile data available for the current selection.
      </div>
    );
  }

  const isGeoref = Boolean(profile.georeferenced);
  const bands = profile.bands;
  const isRegion = profile.mode === 'region';

  // Determine x-axis items (wavelength if numeric, else band name)
  const hasWavelengths = bands.some(b => typeof b.wavelength === 'number');
  const values = bands.map(b => isRegion ? b.mean : b.value).filter(v => typeof v === 'number');
  const maxVal = values.length > 0 ? Math.max(...values) : 1;
  const minVal = values.length > 0 ? Math.min(...values) : 0;

  // Chart SVG coordinates
  const coords = bands.map((b, i) => {
    const val = isRegion ? b.mean : b.value;
    const x = 30 + (i / (bands.length - 1 || 1)) * 140;
    const y = typeof val === 'number'
      ? 65 - ((val - minVal) / (maxVal - minVal || 1)) * 45
      : 65;
    return { ...b, val, x, y, idx: i };
  });

  const validCoords = coords.filter(c => typeof c.val === 'number');
  const pathD = validCoords.reduce((acc, p, i) => i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`, '');

  return (
    <div className="spectral-profile-workspace p-4 rounded-lg bg-slate-900/90 border border-slate-800 space-y-4 text-xs">
      {/* Header & Georeferencing Status */}
      <div className="flex items-start justify-between border-b border-slate-800 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-purple-400">SPECTRAL PROFILE INSPECTION</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-950 text-purple-300 border border-purple-800">
              {isRegion ? 'Region Statistics' : 'Point Inspection'}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {isGeoref ? (
              <span>
                CRS: <strong className="text-slate-200 font-mono">{profile.crs || 'EPSG:4326'}</strong> &bull; Lat/Lng: <span className="font-mono text-emerald-300">{profile.coordinates?.lat?.toFixed(5)}, {profile.coordinates?.lng?.toFixed(5)}</span>
              </span>
            ) : (
              <span className="text-amber-300 font-medium">
                {profile.georefStatus || 'Geospatial point location unavailable because the image is not georeferenced.'}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded border border-slate-800 text-[10px]">
          <button
            onClick={() => setActiveTab('chart')}
            className={`px-2 py-0.5 rounded ${activeTab === 'chart' ? 'bg-purple-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}
          >
            Chart
          </button>
          <button
            onClick={() => setActiveTab('table')}
            className={`px-2 py-0.5 rounded ${activeTab === 'table' ? 'bg-purple-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}
          >
            Bands Table
          </button>
        </div>
      </div>

      {/* Grounded Analysis Connection Note */}
      {profile.analysisContext && (
        <div className="p-2.5 rounded bg-purple-950/40 border border-purple-500/30 text-purple-200 text-[11px] flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <span>{profile.analysisContext}</span>
        </div>
      )}

      {/* SVG Chart View */}
      {activeTab === 'chart' && (
        <div className="bg-slate-950/90 border border-slate-800 rounded p-3 space-y-2">
          <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
            <span>Y: {isRegion ? 'Region Mean' : 'Reflectance / Value'}</span>
            <span>X: {hasWavelengths ? 'Wavelength (nm)' : 'Band Identifier'}</span>
          </div>

          <svg viewBox="0 0 200 80" className="w-full h-auto">
            {/* Grid lines */}
            <line x1="30" y1="20" x2="170" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
            <line x1="30" y1="42" x2="170" y2="42" stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
            <line x1="30" y1="65" x2="170" y2="65" stroke="rgba(255,255,255,0.08)" />

            {/* Path */}
            {pathD && <path d={pathD} fill="none" stroke="#C084FC" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}

            {/* Nodes */}
            {coords.map((c, i) => (
              <g key={i}>
                <circle cx={c.x} cy={c.y} r="3.5" fill="#581C87" stroke="#E9D5FF" strokeWidth="1.8" />
                <text x={c.x} y="75" fill="#CBD5E1" fontSize="5" textAnchor="middle font-mono">
                  {c.wavelength ? `${c.wavelength}nm` : c.band}
                </text>
                {c.val !== null && (
                  <text x={c.x} y={c.y - 5} fill="#E9D5FF" fontSize="4.5" textAnchor="middle font-mono">
                    {typeof c.val === 'number' ? c.val.toFixed(2) : ''}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      )}

      {/* Bands Breakdown Table */}
      {activeTab === 'table' && (
        <div className="overflow-x-auto rounded border border-slate-800">
          <table className="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono text-[10px]">
                <th className="p-2">Band</th>
                <th className="p-2">Name</th>
                <th className="p-2">Wavelength</th>
                {isRegion ? (
                  <>
                    <th className="p-2">Mean</th>
                    <th className="p-2">Min - Max</th>
                    <th className="p-2">Std Dev</th>
                  </>
                ) : (
                  <th className="p-2">Value</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-slate-200">
              {bands.map((b, idx) => (
                <tr key={idx} className="hover:bg-slate-800/40">
                  <td className="p-2 text-purple-300 font-bold">{b.band}</td>
                  <td className="p-2 text-slate-300">{b.name}</td>
                  <td className="p-2 text-slate-400">{b.wavelength ? `${b.wavelength} ${b.wavelengthUnit || 'nm'}` : '—'}</td>
                  {isRegion ? (
                    <>
                      <td className="p-2 text-emerald-400">{typeof b.mean === 'number' ? b.mean.toFixed(4) : '—'}</td>
                      <td className="p-2 text-slate-300">{typeof b.min === 'number' ? `${b.min.toFixed(3)} - ${b.max.toFixed(3)}` : '—'}</td>
                      <td className="p-2 text-slate-400">{typeof b.stdDev === 'number' ? b.stdDev.toFixed(4) : '—'}</td>
                    </>
                  ) : (
                    <td className="p-2 text-emerald-400">{typeof b.value === 'number' ? b.value.toFixed(4) : '—'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
