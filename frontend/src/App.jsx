import { useState, useCallback } from 'react';
import GlobeView from './Components/GlobeView';
import SearchBar from './Components/SearchBar';
import Sidebar from './Components/Sidebar';
import TopBar from './Components/TopBar';
import ResultsPanel from './Components/ResultsPanel';
import { MenuToggleIcon } from './Components/ui/MenuToggleIcon';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  const [activeMode, setActiveMode] = useState('single');
  const [coords, setCoords] = useState(null);

  const handleCoords = useCallback((c) => setCoords(c), []);

  const handleSubmit = (q, mode) => {
    setSubmitted(q);
    setActiveMode(mode);
  };

  return (
    <div className="satquery-app">
      <main className="main-stage">
        <div className="globe-section">
          <GlobeView onCoordsChange={handleCoords} activeQuery={submitted} />

          <TopBar coords={coords} activeQuery={submitted} />

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
            <SearchBar
              onSubmit={handleSubmit}
              onClear={() => setSubmitted(null)}
              onModeChange={setActiveMode}
            />
          </div>

          <ResultsPanel query={submitted} onClose={() => setSubmitted(null)} />
        </div>
      </main>

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeQuery={submitted}
        activeMode={activeMode}
      />
    </div>
  );
}
