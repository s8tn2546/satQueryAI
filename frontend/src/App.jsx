import { useState } from 'react';
import GlobeView from './Components/GlobeView';
import SearchBar from './Components/SearchBar';
import Sidebar from './Components/Sidebar';
import { MenuToggleIcon } from './Components/ui/MenuToggleIcon';

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
              <MenuToggleIcon open={sidebarOpen} style={{ width: 20, height: 20 }} duration={500} />
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
