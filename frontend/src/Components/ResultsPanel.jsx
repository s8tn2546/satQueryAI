export default function ResultsPanel({ query, onClose }) {
  if (!query) return null;

  return (
    <div className="results-panel">
      <div className="results-panel-header">
        <div className="results-panel-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Analysis Result
        </div>
        <button className="results-panel-close" onClick={onClose} title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="results-panel-query">
        <span className="results-panel-query-label">QUERY</span>
        <p className="results-panel-query-text">"{query}"</p>
      </div>

      <div className="results-panel-status">
        <span className="results-panel-badge">
          <span className="results-panel-badge-dot" />
          Processing
        </span>
        <span className="results-panel-confidence">VLM · Qwen2-VL</span>
      </div>

      <div className="results-panel-body">
        <div className="results-panel-skeleton">
          <div className="results-skeleton-line w-full" />
          <div className="results-skeleton-line w-4/5" />
          <div className="results-skeleton-line w-3/5" />
        </div>
        <p className="results-panel-hint">
          Satellite imagery is being processed. Results will appear here once the visual analysis is complete.
        </p>
      </div>

      <div className="results-panel-meta">
        <span className="results-meta-item">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          Just now
        </span>
        <span className="results-meta-item">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          Active location
        </span>
      </div>
    </div>
  );
}
