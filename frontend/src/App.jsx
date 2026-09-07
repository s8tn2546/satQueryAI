import { useState, useCallback, useEffect } from 'react';
import GlobeView from './Components/GlobeView';
import SearchBar from './Components/SearchBar';
import Sidebar from './Components/Sidebar';
import TopBar from './Components/TopBar';
import ResultsPanel from './Components/ResultsPanel';
import ResultPanel from './Components/ResultPanel';
import SidebarIcon from './Components/SidebarIcon';
import { submitQuery, fetchQueryHistory } from './services/api';

const SESSION_KEY = 'satquery.sessionId';

function getSessionId() {
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        window.crypto && typeof window.crypto.randomUUID === 'function'
          ? window.crypto.randomUUID()
          : `sat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessionId] = useState(getSessionId);
  const [submitted, setSubmitted] = useState(null);
  const [activeMode, setActiveMode] = useState('single');
  const [attachedImages, setAttachedImages] = useState([]);
  const [coords, setCoords] = useState(null);
  const [tileIds, setTileIds] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [response, setResponse] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [activeHistoryId, setActiveHistoryId] = useState(null);

  const handleCoords = useCallback((c) => setCoords(c), []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchQueryHistory({ sessionId, limit: 20 })
      .then(items => {
        if (cancelled) return;
        setHistory(Array.isArray(items) ? items : []);
        setHistoryError(null);
      })
      .catch(() => {
        if (!cancelled) setHistoryError('Could not load history.');
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const refreshHistory = async () => {
    if (!sessionId) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const items = await fetchQueryHistory({ sessionId, limit: 20 });
      setHistory(Array.isArray(items) ? items : []);
    } catch {
      setHistoryError('Could not load history.');
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSubmit = async (queryText, mode, imgs = []) => {
    if (isLoading || !queryText || !queryText.trim()) return;
    if (mode) setActiveMode(mode);
    setAttachedImages(imgs);
    setError(null);
    setSubmitted(queryText);
    setIsLoading(true);
    try {
      const payload = await submitQuery({
        queryText: queryText.trim(),
        imageRefs: tileIds,
        parameters: {},
        sessionId,
      });
      setResponse(payload);
      refreshHistory();
    } catch (err) {
      setError((err && err.message) || 'Something went wrong.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setSubmitted(null);
    setAttachedImages([]);
    setResponse(null);
    setError(null);
    setActiveHistoryId(null);
  };

  const handleSelectHistory = (item) => {
    if (!item) return;
    setSubmitted(item.queryText || item.query || '');
    setError(null);
    setActiveHistoryId(item._id || item.id || null);
    if (item.result || item.answerText) {
      const { result, answerText, taskType, status, plan, toolResults, evidence, confidence,
        confidenceSignals, executionTrace, parameters } = item;
      setResponse({
        result,
        answerText,
        taskType,
        status,
        plan,
        toolResults,
        evidence,
        confidence,
        confidenceSignals,
        executionTrace,
        parameters,
      });
    }
  };

  return (
    <div className="satquery-app">
      <main className="main-stage">
        <div className="globe-section">
          <GlobeView onCoordsChange={handleCoords} activeQuery={submitted} />

          <TopBar coords={coords} activeQuery={submitted} />

          <div className="globe-controls-left">
            <button
              className="sidebar-launch sidebar-launch-btn"
              onClick={() => setSidebarOpen(v => !v)}
              title={sidebarOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={sidebarOpen}
            >
              <SidebarIcon size={26} />
            </button>
          </div>

          <div className="globe-search">
            <SearchBar
              onSubmit={handleSubmit}
              onClear={handleClear}
              onModeChange={setActiveMode}
              disabled={isLoading}
              onTilesChange={setTileIds}
            />

            {isLoading && !response && (
              <div className="search-result search-result-loading">
                <div className="search-result-header">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <span className="search-result-query">{submitted}</span>
                  <span className="search-result-confidence">Analyzing</span>
                </div>
                <p className="search-result-text">
                  Running the agent pipeline for "{submitted}"... Results will appear here.
                </p>
              </div>
            )}

            {error && (
              <div className="search-result search-result-error">
                <div className="search-result-header">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <span className="search-result-query">Something went wrong</span>
                  <span className="result-status status-failed">failed</span>
                </div>
                <p className="search-result-text">{error}</p>
              </div>
            )}

            {response && !error && <ResultPanel response={response} />}
          </div>

          {submitted && !response && (
            <ResultsPanel 
              query={submitted} 
              resultData={attachedImages.length > 0 ? { uploadedImages: attachedImages } : null}
              onClose={handleClear} 
            />
          )}
        </div>
      </main>

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeQuery={submitted}
        activeMode={activeMode}
        history={history}
        historyLoading={historyLoading}
        historyError={historyError}
        activeHistoryId={activeHistoryId}
        onNewAnalysis={handleClear}
        onSelectHistory={handleSelectHistory}
      />
    </div>
  );
}
