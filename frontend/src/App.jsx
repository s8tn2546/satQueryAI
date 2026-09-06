import { useState } from 'react';
import GlobeView from './Components/GlobeView';
import SearchBar from './Components/SearchBar';
import Sidebar from './Components/Sidebar';

const MenuIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const PanelRightIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    <line x1="12" y1="2" x2="12" y2="22" />
  </svg>
);

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [submitted, setSubmitted] = useState(null);

  return (
    <div className="satquery-app">
      <main className="main-stage">
        <div className="globe-section">
          <GlobeView />

          <div className="globe-controls-left">
            <button
              className="sidebar-launch theme-toggle-btn"
              onClick={() => setSidebarOpen(v => !v)}
              title={sidebarOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={sidebarOpen}
            >
              {sidebarOpen ? <PanelRightIcon /> : <MenuIcon />}
            </button>
          </div>

          <div className="globe-search">
            <SearchBar onSubmit={q => setSubmitted(q)} onClear={() => setSubmitted(null)} />
            {submitted && (
              <div className="search-result">
                <div className="search-result-header">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <span className="search-result-query">{submitted}</span>
                  <span className="search-result-confidence">Queued</span>
                </div>
                <p className="search-result-text">
                  Analysis for "{submitted}" has been queued on the 3D earth. Results will appear here.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    </div>
  );
}
