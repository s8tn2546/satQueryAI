import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import GlobeView from './Components/GlobeView';
import SearchBar from './Components/SearchBar';
import Sidebar from './Components/Sidebar';
import TopBar from './Components/TopBar';
import ResultsPanel from './Components/ResultsPanel';
import SidebarIcon from './Components/SidebarIcon';
import { submitQuery, fetchQueryHistory, uploadImages, fetchRegionImagery, warmupVlm, bboxToGeoJSONPolygon } from './services/api';

const SESSION_KEY = 'satquery.sessionId';

// When a two-image mode is selected but the query text does not already
// express the task, prepend a minimal honest hint so the deterministic
// heuristic intent classifier (and any LLM) routes to the right tool.
const MODE_TASK_HINT = {
  temporal: { prefix: 'Detect changes between these two images. ', triggers: ['chang', 'between these two', 'bi-temporal'] },
  sar: { prefix: 'Fuse optical and SAR imagery. ', triggers: ['fus', 'optical'] },
};

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
  const navigate = useNavigate();
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
  const [roiAttachment, setRoiAttachment] = useState(null);
  // Backend tile IDs resolved for the CURRENT visible result. Persisted in the
  // Query document (inputRefs), so History restores the same source imagery.
  const [submittedTileIds, setSubmittedTileIds] = useState([]);

  useEffect(() => {
    document.body.classList.add('app-route');
    return () => document.body.classList.remove('app-route');
  }, []);

  const handleCoords = useCallback((c) => setCoords(c), []);

  const buildResultData = (res, uploaded, imageRefs) => {
    const result = res?.result && typeof res.result === 'object' ? res.result : {};
    const boxes = Array.isArray(result.boxes)
      ? result.boxes
      : Array.isArray(result.detections)
        ? result.detections
        : [];
    return {
      answerText: res?.answerText || '',
      boxes,
      trace: res?.executionTrace || [],
      uploadedImages: uploaded,
      toolResults: Array.isArray(res?.toolResults) ? res.toolResults : [],
      imageRefs: Array.isArray(imageRefs) ? imageRefs : [],
      evidence: res?.evidence && typeof res.evidence === 'object' ? res.evidence : null,
      parameters: res?.parameters && typeof res.parameters === 'object' ? res.parameters : {},
      trendData: res?.trendData || result?.trendData || null,
      metrics: result?.metrics && typeof result.metrics === 'object' ? result.metrics : {},
      modelMetadata: res?.modelMetadata && typeof res.modelMetadata === 'object' ? res.modelMetadata : {},
      severity: res?.severity || null,
      confidence: typeof res?.confidence === 'number' ? res.confidence : null,
      status: res?.status || null,
      taskType: res?.taskType || null,
      isMockResult: Array.isArray(res?.toolResults)
        ? res.toolResults.some((t) => Boolean(t && t.metadata && t.metadata.mock === true))
        : false,
      qualityReport: res?.qualityReport || null,
      roiAttachment,
    };
  };

  const [roiTileIds, setRoiTileIds] = useState([]);

  const handleRegionSelect = async (bbox) => {
    const label = `ROI ${bbox.south.toFixed(3)}°N, ${bbox.west.toFixed(3)}°E`;
    let fetchedIds = [];
    try {
      const fetched = await fetchRegionImagery(bbox, { mode: activeMode });
      const imageList = Array.isArray(fetched?.images) ? fetched.images : [];
      fetchedIds = imageList
        .map((t) => t && (t.tileId || t._id))
        .filter(Boolean);
      if (fetchedIds.length === 0 && Array.isArray(fetched?.tileIds)) {
        fetchedIds = fetched.tileIds;
      }
    } catch (err) {
      console.warn('Region fetch notice:', err.message);
    }
    setRoiTileIds(fetchedIds);
    if (fetchedIds.length > 0) {
      setTileIds((prev) => [...prev, ...fetchedIds]);
    }
    setRoiAttachment({ name: label, bbox, tileIds: fetchedIds });
  };

  const handleClearRoi = () => {
    if (roiTileIds.length > 0) {
      setTileIds((prev) => prev.filter((id) => !roiTileIds.includes(id)));
    }
    setRoiAttachment(null);
    setRoiTileIds([]);
  };

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

  // Best-effort VLM warm-up so the first real query does not pay the
  // cold-start cost. Safe: backend skips it while a query is in flight, and
  // it never blocks the UI (fire-and-forget, failures ignored silently).
  useEffect(() => {
    let cancelled = false;
    warmupVlm()
      .then((r) => {
        if (!cancelled && r && r.status === 'ok') {
          console.info(`[warmup] VLM ready (model=${r.model}, LoRA active=${r.adapter_active})`);
        }
      })
      .catch(() => { /* warmup is best-effort */ });
    return () => { cancelled = true; };
  }, []);

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
    const text = (queryText && queryText.trim()) || '';
    if (isLoading || (!text && imgs.length === 0)) return;

    const avMode = mode || activeMode;
    const hint = MODE_TASK_HINT[avMode];
    const alreadyHints = hint
      ? hint.triggers.some((t) => text.toLowerCase().includes(t))
      : true;
    const finalQuery = `${hint && !alreadyHints ? hint.prefix : ''}${text || 'Analyze uploaded satellite imagery'}`;

    if (mode) setActiveMode(mode);
    setAttachedImages(imgs);
    setError(null);
    setSubmitted(finalQuery);
    // Clear any previous/stale result up front: a completed-looking panel must
    // never stay visible while the new request is still pending.
    setResponse(null);
    setActiveHistoryId(null);
    setSubmittedTileIds([]);
    setIsLoading(true);
    try {
      // Only real backend Mongo tile IDs (24-hex) may be sent as imageRefs.
      // Any UI-only/searchbar-generated IDs are excluded.
      let activeTileIds = tileIds.filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
      if (imgs.length > 0) {
        try {
          const files = imgs.map((i) => i.file).filter(Boolean);
          if (files.length > 0) {
            const uploadRes = await uploadImages(files, {
              source: 'benchmark-upload',
              // Declare per-file modality so "Optical + SAR" mode actually
              // produces one optical + one SAR tile; other modes are optical.
              modality: avMode === 'sar' ? files.map((_, i) => (i === 0 ? 'optical' : 'sar')) : 'optical',
            });
            if (uploadRes) {
              const newIds = uploadRes.tileIds || (uploadRes.tileId ? [uploadRes.tileId] : []);
              if (newIds.length > 0) {
                // Uploaded backend tile IDs are authoritative and replace any
                // stale client IDs (merged with real ROI tile IDs, never with
                // SearchBar UI IDs).
                activeTileIds = [...activeTileIds, ...newIds];
              }
            }
          }
        } catch (uploadErr) {
          console.warn('Image upload API notice:', uploadErr.message);
        }
      }

      // For temporal mode on plain rendered images (PNG/JPEG — no band
      // metadata), the user must explicitly assert which band to compare;
      // the ML service refuses to guess band meaning itself. Band 1 is the
      // visible first channel of a plain image. Labelled/georeferenced
      // rasters are left alone so the service can match bands by name.
      const isPlainRaster = imgs.length >= 2
        ? imgs.every((i) => /\.(png|jpe?g|webp)$/i.test((i && i.name) || (i?.file && i.file.name) || ''))
        : false;
      const parameters = { mode: avMode };
      if (avMode === 'temporal' && isPlainRaster) parameters.band = 1;
      // A drawn region of interest is the analysis's AOI scope. It reaches the
      // tool as a GeoJSON geometry (same canonical polygon used for region-based
      // acquisition) so the region is part of the request, not decorative.
      const aoi = bboxToGeoJSONPolygon(roiAttachment?.bbox);
      if (aoi) parameters.aoi = aoi;

      const payload = await submitQuery({
        queryText: finalQuery,
        imageRefs: activeTileIds,
        parameters,
        sessionId,
      });
      setResponse(payload);
      setSubmittedTileIds(activeTileIds);
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
    setSubmittedTileIds([]);
  };

  const handleSignOut = () => {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
    try {
      window.localStorage.removeItem('userEmail');
      window.localStorage.removeItem('rememberMe');
    } catch { /* ignore */ }
    setSidebarOpen(false);
    handleClear();
    navigate('/login');
  };

  const handleSelectHistory = (item) => {
    if (!item) return;
    setSubmitted(item.queryText || item.query || '');
    setError(null);
    setActiveHistoryId(item._id || item.id || null);
    // Restore the SAME analytical context: source imagery (persisted tile ids),
    // findings, evidence, trend state, trace, confidence.
    const inputRefs = Array.isArray(item.inputRefs)
      ? item.inputRefs
      : (item.evidence && Array.isArray(item.evidence.images) ? item.evidence.images : []);
    setSubmittedTileIds(inputRefs);
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
        _id: item._id,
      });
    }
  };

  const handleInvestigatePeriod = (pt1, pt2) => {
    const periodQuery = `Analyze change from ${pt1.label} to ${pt2.label}`;
    handleSubmit(periodQuery, 'temporal');
  };

  return (
    <div className="satquery-app">
      <main className="main-stage">
        <div className="globe-section">
          <GlobeView 
            onCoordsChange={handleCoords} 
            activeQuery={submitted} 
            onRegionSelect={handleRegionSelect}
            roiAttachment={roiAttachment}
            onClearRoi={handleClearRoi}
          />

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
              roiAttachment={roiAttachment}
              onClearRoi={handleClearRoi}
            />

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
          </div>

          {submitted && (
            <ResultsPanel
              query={submitted}
              resultData={response ? buildResultData(response, attachedImages, submittedTileIds) : (attachedImages.length > 0 ? { uploadedImages: attachedImages } : null)}
              onClose={handleClear}
              isAnalyzing={isLoading}
              onInvestigatePeriod={handleInvestigatePeriod}
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
        onSignOut={handleSignOut}
      />
    </div>
  );
}
