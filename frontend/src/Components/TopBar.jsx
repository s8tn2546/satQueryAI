import SatQueryLogo from './SatQueryLogo';

export default function TopBar({ coords, activeQuery }) {
  const lat = coords ? coords.lat.toFixed(4) : '—';
  const lon = coords ? coords.lon.toFixed(4) : '—';

  return (
    <div className="topbar">
      <div className="topbar-brand">
        <div className="topbar-logo">
          <SatQueryLogo size={28} />
        </div>
      </div>

      <div className="topbar-center">
        <div className="topbar-coords">
          <span className="topbar-coords-label">LAT</span>
          <span className="topbar-coords-val">{lat}</span>
          <span className="topbar-coords-sep">·</span>
          <span className="topbar-coords-label">LON</span>
          <span className="topbar-coords-val">{lon}</span>
        </div>
      </div>

      <div className="topbar-right">
        <div className={`topbar-status ${activeQuery ? 'active' : 'idle'}`}>
          <span className="topbar-status-dot" />
          <span className="topbar-status-text">{activeQuery ? 'ANALYZING' : 'STANDBY'}</span>
        </div>
      </div>
    </div>
  );
}
