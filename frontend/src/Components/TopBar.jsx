export default function TopBar({ coords, activeQuery }) {
  const lat = coords ? coords.lat.toFixed(4) : '—';
  const lon = coords ? coords.lon.toFixed(4) : '—';

  return (
    <div className="topbar">
      <div className="topbar-brand">
        <div className="topbar-logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>
        <div className="topbar-wordmark">
          <span className="topbar-name">SatQuery</span>
          <span className="topbar-tag">AI</span>
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
