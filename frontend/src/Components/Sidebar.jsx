import { useState } from 'react';

const PlusIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const LayersIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

const ClockIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const ChevronRightIcon = ({ size = 14, className = '' }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const SettingsIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const LogOutIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const XIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export default function Sidebar({ 
  open, 
  onClose, 
  activeQuery, 
  activeMode, 
  history = [], 
  historyLoading = false, 
  historyError = null, 
  activeHistoryId = null,
  onNewAnalysis, 
  onSelectHistory 
}) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const modeLabel = { single: 'Single Scene', temporal: 'T1 + T2', sar: 'Optical + SAR' };

  const items = Array.isArray(history) ? history : [];

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      {/* 1. Wordmark + Close */}
      <div className="sidebar-brand">
        <span className="sidebar-brand-name">
          SatQuery <span className="sidebar-brand-ai">AI</span>
        </span>
        <button className="sidebar-close" onClick={onClose} title="Close sidebar">
          <XIcon size={16} />
        </button>
      </div>

      <div className="sidebar-content">
        {/* 2. Full-width primary button */}
        <div className="sidebar-head">
          <button 
            className="new-analysis-btn"
            onClick={() => {
              onNewAnalysis && onNewAnalysis();
              onClose && onClose();
            }}
          >
            <PlusIcon size={16} />
            <span>New analysis</span>
          </button>
        </div>

        {/* 3. Section label: CURRENT SESSION */}
        <div className="sidebar-section-label">CURRENT SESSION</div>

        {/* 4. Current Session Glass Card */}
        <div className="sidebar-session-card">
          <div className="sidebar-session-main">
            <div className="sidebar-session-row">
              <LayersIcon size={14} />
              <span className="sidebar-session-mode">
                Mode: {modeLabel[activeMode] || 'Single Scene'}
              </span>
            </div>
            <div className="sidebar-session-status">
              <span className="status-online-dot" />
              <span className="status-text">{activeQuery ? 'Active Query' : 'Standby'}</span>
            </div>
          </div>
          <ChevronRightIcon size={14} className="sidebar-card-chevron" />
        </div>

        {/* 5. Nav row: History Toggle */}
        <button 
          className={`sidebar-nav-row ${historyOpen ? 'active' : ''}`}
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <div className="sidebar-nav-left">
            <ClockIcon size={16} />
            <span className="sidebar-nav-label">History ({items.length})</span>
          </div>
          <ChevronRightIcon size={14} className={`sidebar-nav-chevron ${historyOpen ? 'rotate-90' : ''}`} />
        </button>

        {/* Expanded History List */}
        {historyOpen && (
          <div className="sidebar-history-list">
            {historyLoading ? (
              <div className="sidebar-history-meta">Loading history...</div>
            ) : historyError ? (
              <div className="sidebar-history-meta">{historyError}</div>
            ) : items.length === 0 ? (
              <div className="sidebar-history-meta">No analysis history yet.</div>
            ) : (
              items.map((item) => {
                const label = item.queryText || item.query || 'Untitled analysis';
                const mode = item.mode || item.taskType || 'single';
                const time = item.time || (item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '');
                const isActive = activeHistoryId && (activeHistoryId === item._id || activeHistoryId === item.id);

                return (
                  <div 
                    key={item._id || item.id || label} 
                    className={`sidebar-history-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      onSelectHistory && onSelectHistory(item);
                      onClose && onClose();
                    }}
                  >
                    <div className="sidebar-history-title">"{label}"</div>
                    <div className="sidebar-history-meta">
                      <span>{modeLabel[mode] || mode}</span>
                      {time && <span>· {time}</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 6. Flexible spacer pushing profile to bottom */}
        <div className="sidebar-spacer" />

        {/* 7. Profile row */}
        <div className="sidebar-profile-card">
          <div className="sidebar-avatar-wrapper">
            <div className="sidebar-avatar">AK</div>
            <span className="sidebar-avatar-online" />
          </div>
          <div className="sidebar-profile-info">
            <span className="sidebar-profile-name">Aryan Kumar</span>
            <span className="sidebar-profile-email">aryan@satquery.ai</span>
          </div>
          <ChevronRightIcon size={14} className="sidebar-profile-chevron" />
        </div>

        {/* 8. Settings & Sign Out nav rows */}
        <div className="sidebar-bottom-nav">
          <button className="sidebar-nav-row">
            <div className="sidebar-nav-left">
              <SettingsIcon size={16} />
              <span className="sidebar-nav-label">Settings</span>
            </div>
            <ChevronRightIcon size={14} className="sidebar-nav-chevron" />
          </button>

          <button className="sidebar-nav-row">
            <div className="sidebar-nav-left">
              <LogOutIcon size={16} />
              <span className="sidebar-nav-label">Sign out</span>
            </div>
            <ChevronRightIcon size={14} className="sidebar-nav-chevron" />
          </button>
        </div>
      </div>
    </aside>
  );
}
