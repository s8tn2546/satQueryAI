import ThemeToggle from './ThemeToggle';

const historyItems = [];

export default function Sidebar({ open, onClose, activeQuery, activeMode }) {
  const modeLabel = { single: 'Single Scene', temporal: 'T1 + T2', sar: 'Optical + SAR' };

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-brand">
        <div className="sidebar-brand-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>
        <span className="sidebar-brand-name">SatQuery <span className="sidebar-brand-ai">AI</span></span>
        <button className="sidebar-close" onClick={onClose} title="Close sidebar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="sidebar-head">
        <button className="new-chat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New analysis
        </button>
      </div>

      {(activeQuery || activeMode) && (
        <div className="sidebar-session">
          <p className="sidebar-session-label">CURRENT SESSION</p>
          {activeMode && (
            <div className="sidebar-session-row">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
              </svg>
              <span className="sidebar-session-key">Mode</span>
              <span className="sidebar-session-val">{modeLabel[activeMode] || activeMode}</span>
            </div>
          )}
          {activeQuery && (
            <div className="sidebar-session-query">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="sidebar-session-key">Query</span>
              <span className="sidebar-session-val sidebar-session-query-text">{activeQuery}</span>
            </div>
          )}
        </div>
      )}

      <div className="sidebar-scroll">
        <nav className="sidebar-nav">
          <p className="nav-label nav-label-top">History</p>
          {historyItems.length === 0 ? (
            <div className="sidebar-empty-state">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <p className="sidebar-empty-title">No analyses yet</p>
              <p className="sidebar-empty-sub">Submit a query to start exploring satellite imagery.</p>
            </div>
          ) : (
            <ul className="history-list">
              {historyItems.map(item => (
                <li key={item.id}>
                  <button className="history-row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span><b>{item.title}</b><small>{item.task} · {item.time}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">AK</div>
          <div className="sidebar-user-info">
            <span className="sidebar-user-name">Aryan Kumar</span>
            <span className="sidebar-user-email">aryan@satquery.ai</span>
          </div>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
