import { useState } from 'react';
import TrendChart from './TrendChart';

export default function ResultsPanel({ query, resultData, onClose }) {
  const [activeTab, setActiveTab] = useState('evidence');
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [showMask, setShowMask] = useState(false);
  const [boxOpacity, setBoxOpacity] = useState(100);
  const [maskOpacity, setMaskOpacity] = useState(60);
  const [selectedBoxId, setSelectedBoxId] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  if (!query) return null;

  const answer = resultData?.answerText || '';
  const boxes = Array.isArray(resultData?.boxes) ? resultData.boxes : [];
  const steps = Array.isArray(resultData?.trace)
    ? resultData.trace
    : Array.isArray(resultData?.executionTrace)
      ? resultData.executionTrace
      : [];
  const imageUrl = resultData?.uploadedImages?.[0]?.url || '';
  const trendData = resultData?.trendData || null;
  const metrics = resultData?.metrics || {};
  const modelMetadata = resultData?.modelMetadata || {};
  const severity = resultData?.severity || null;

  const confidence = resultData?.confidence != null
    ? `${(Number(resultData.confidence) * 100).toFixed(1)}%`
    : null;

  const hasResult = Boolean(answer || boxes.length || steps.length || imageUrl);

  const handleDownloadReport = () => {
    if (!hasResult) return;
    setIsExporting(true);
    setTimeout(() => {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const stepRows = steps.length
        ? steps.map((s) => `
        <li class="step-item">
          <div class="step-num">✓</div>
          <div>
            <div class="step-title">${s.title || s.step}${s.latency ? ` (${s.latency})` : ''}</div>
            <div class="step-desc">${s.desc || ''}</div>
          </div>
        </li>
      `).join('')
        : '<li class="step-item"><div class="step-desc">No execution trace recorded.</div></li>';

      const reportContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SatQuery AI — Intelligence Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #060913; color: #f1f5f9; padding: 40px; margin: 0; }
    .header { border-bottom: 2px solid #3b7ddd; padding-bottom: 20px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
    .logo-title { font-size: 22px; font-weight: 800; color: #6eb4ff; letter-spacing: -0.5px; }
    .tag { background: rgba(59, 125, 221, 0.2); border: 1px solid #3b7ddd; padding: 4px 10px; border-radius: 6px; font-size: 11px; color: #8fc5ff; font-weight: 700; }
    .card { background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #94a3b8; letter-spacing: 1.2px; margin-bottom: 8px; }
    .query-text { font-size: 18px; font-weight: 600; color: #ffffff; margin: 0; }
    .section-title { font-size: 14px; font-weight: 700; color: #8fc5ff; letter-spacing: 0.5px; margin: 28px 0 14px; text-transform: uppercase; border-left: 3px solid #3b7ddd; padding-left: 10px; }
    .answer-body { font-size: 15px; line-height: 1.7; color: #cbd5e1; }
    .step-list { list-style: none; padding: 0; margin: 0; }
    .step-item { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
    .step-num { width: 22px; height: 22px; border-radius: 50%; background: #3b7ddd; color: #ffffff; font-weight: bold; font-size: 12px; display: grid; place-items: center; flex: none; }
    .step-title { font-size: 14px; font-weight: 600; color: #f1f5f9; }
    .step-desc { font-size: 12px; color: #94a3b8; margin-top: 2px; }
    .footer { margin-top: 60px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 20px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">SATQUERY AI <span style="font-weight: 400; color: #94a3b8;">| Earth Intelligence Report</span></div>
    <div class="tag">CONFIDENT GEOINT</div>
  </div>

  <div class="card">
    <div class="label">Target Analysis Query</div>
    <p class="query-text">"${query}"</p>
    <div style="margin-top: 14px; font-size: 12px; color: #94a3b8;">
      Generated: ${new Date().toLocaleString()}
    </div>
  </div>

  <div class="section-title">Executive Summary & Findings</div>
  <div class="card answer-body">
    ${answer || 'No findings available for this query.'}
  </div>

  <div class="section-title">Execution Trace & Verification Pipeline</div>
  <div class="card">
    <ul class="step-list">
      ${stepRows}
    </ul>
  </div>

  <div class="footer">
    SatQuery AI Platform — Confident Earth Intelligence Engine &nbsp;·&nbsp; Confidential GEOINT Output
  </div>
</body>
</html>
      `;

      const blob = new Blob([reportContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `SatQuery_GEOINT_Report_${timestamp}.html`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setIsExporting(false);
    }, 600);
  };

  const handleExportGeoJSON = () => {
    if (!boxes.length) return;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const geojson = {
      type: 'FeatureCollection',
      name: 'SatQuery_Detections',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features: boxes.map((box) => ({
        type: 'Feature',
        properties: {
          id: box.id,
          label: box.label,
          confidence: box.confidence,
          area: box.area,
        },
        geometry: box.geometry || null,
      })),
    };

    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SatQuery_Detections_${timestamp}.geojson`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`results-panel ${isFullscreen ? 'fullscreen' : ''}`}>
      {/* Header */}
      <div className="results-panel-header">
        <div className="results-panel-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Analysis Result
        </div>
        <div className="results-panel-header-actions">
          <button
            className="download-report-btn"
            onClick={handleDownloadReport}
            disabled={isExporting || !hasResult}
            title={hasResult ? 'Export Satellite Intelligence Report (HTML)' : 'No data to export'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>{isExporting ? 'Exporting...' : 'HTML Report'}</span>
          </button>
          <button
            className="export-geojson-btn"
            onClick={handleExportGeoJSON}
            disabled={!boxes.length}
            title={boxes.length ? 'Export Detections to GeoJSON Format' : 'No detections to export'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span>GeoJSON</span>
          </button>
          <button
            className="results-panel-fullscreen-btn"
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? 'Downsize / Exit Fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="10" y1="14" x2="3" y2="21" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
          <button className="results-panel-close" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Query Title */}
      <div className="results-panel-query">
        <span className="results-panel-query-label">TARGET QUERY</span>
        <p className="results-panel-query-text">"{query}"</p>
      </div>

      {/* Status Bar */}
      <div className="results-panel-status">
        <span className="results-panel-badge ready">
          <span className="results-panel-badge-dot" />
          {hasResult ? 'Analysis Complete' : 'Awaiting Data'}
        </span>
        {confidence && <span className="results-panel-confidence">Confidence: {confidence}</span>}
      </div>

      {/* Navigation Tabs */}
      <div className="results-tabs">
        <button className={`results-tab ${activeTab === 'evidence' ? 'active' : ''}`} onClick={() => setActiveTab('evidence')}>
          Evidence
        </button>
        <button className={`results-tab ${activeTab === 'answer' ? 'active' : ''}`} onClick={() => setActiveTab('answer')}>
          Findings
        </button>
        <button className={`results-tab ${activeTab === 'trend' ? 'active' : ''}`} onClick={() => setActiveTab('trend')}>
          Trend
        </button>
        <button className={`results-tab ${activeTab === 'trace' ? 'active' : ''}`} onClick={() => setActiveTab('trace')}>
          Trace
        </button>
      </div>

      {/* Body Content */}
      <div className="results-panel-body">
        {/* Tab 1: Visual Evidence */}
        {activeTab === 'evidence' && (
          <div className="results-evidence-view">
            {imageUrl ? (
              <>
                <div className="evidence-controls-stack">
                  <div className="evidence-controls">
                    <button className={`layer-toggle-btn ${showBoundingBoxes ? 'active' : ''}`} onClick={() => setShowBoundingBoxes(!showBoundingBoxes)}>
                      <span className="toggle-indicator" />
                      Bounding Boxes
                    </button>
                    <button className={`layer-toggle-btn ${showMask ? 'active' : ''}`} onClick={() => setShowMask(!showMask)}>
                      <span className="toggle-indicator" />
                      Segmentation Mask
                    </button>
                  </div>

                  <div className="evidence-sliders-row">
                    {showBoundingBoxes && (
                      <div className="opacity-slider-item">
                        <span className="slider-label">Boxes: {boxOpacity}%</span>
                        <input
                          type="range"
                          min="10"
                          max="100"
                          value={boxOpacity}
                          onChange={(e) => setBoxOpacity(Number(e.target.value))}
                          className="opacity-range-input"
                        />
                      </div>
                    )}
                    {showMask && (
                      <div className="opacity-slider-item">
                        <span className="slider-label">Mask: {maskOpacity}%</span>
                        <input
                          type="range"
                          min="10"
                          max="100"
                          value={maskOpacity}
                          onChange={(e) => setMaskOpacity(Number(e.target.value))}
                          className="opacity-range-input"
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="evidence-viewport aspect-ratio-locked">
                  <div className="evidence-canvas-frame">
                    <div
                      className="evidence-satellite-bg"
                      style={{
                        backgroundImage: `url(${imageUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }}
                    >
                      <div className="satellite-grid-overlay" />

                      {showMask && (
                        <div
                          className="evidence-mask-layer"
                          style={{
                            position: 'absolute',
                            inset: 0,
                            opacity: maskOpacity / 100,
                            background: 'radial-gradient(ellipse at 35% 30%, rgba(59, 125, 221, 0.45) 0%, rgba(110, 180, 255, 0.3) 50%, transparent 80%)',
                            mixBlendMode: 'screen',
                            transition: 'opacity 0.15s ease',
                          }}
                        />
                      )}

                      {showBoundingBoxes && boxes.length > 0 && (
                        <svg
                          className="evidence-svg-overlay"
                          viewBox="0 0 100 100"
                          preserveAspectRatio="xMidYMid meet"
                          style={{ opacity: boxOpacity / 100, transition: 'opacity 0.15s ease' }}
                        >
                          {boxes.map((box) => {
                            const isSelected = selectedBoxId === box.id;
                            return (
                              <g
                                key={box.id}
                                className={`bounding-box-group ${isSelected ? 'selected' : ''}`}
                                onClick={() => setSelectedBoxId(isSelected ? null : box.id)}
                                style={{ cursor: 'pointer' }}
                              >
                                <rect
                                  x={box.x}
                                  y={box.y}
                                  width={box.width}
                                  height={box.height}
                                  fill={isSelected ? "rgba(110, 180, 255, 0.25)" : "rgba(110, 180, 255, 0.14)"}
                                  stroke={isSelected ? "#8FC5FF" : "#6EB4FF"}
                                  strokeWidth={isSelected ? "1.4" : "0.9"}
                                  strokeDasharray={isSelected ? "none" : "2 1"}
                                  rx="1"
                                />
                                <rect
                                  x={box.x}
                                  y={box.y - 6}
                                  width={box.width * 0.82}
                                  height="5.5"
                                  fill="#3B7DDD"
                                  rx="0.8"
                                />
                                <text
                                  x={box.x + 1.5}
                                  y={box.y - 1.8}
                                  fill="#FFFFFF"
                                  fontSize="3.2"
                                  fontWeight="bold"
                                >
                                  {box.label}{box.confidence ? ` (${box.confidence})` : ''}
                                </text>
                              </g>
                            );
                          })}
                        </svg>
                      )}
                    </div>
                  </div>
                </div>

                {boxes.length > 0 && (
                  <div className="evidence-detections-list">
                    <span className="detections-list-title">DETECTED TARGETS:</span>
                    <div className="detections-chips">
                      {boxes.map((box) => (
                        <button
                          key={box.id}
                          type="button"
                          className={`detection-chip ${selectedBoxId === box.id ? 'active' : ''}`}
                          onClick={() => setSelectedBoxId(selectedBoxId === box.id ? null : box.id)}
                        >
                          <span className="chip-dot" />
                          <span className="chip-label">{box.label}</span>
                          {box.confidence && <span className="chip-conf">{box.confidence}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="results-empty-state">
                No satellite imagery available for this query yet.
              </p>
            )}
          </div>
        )}

        {/* Tab 2: Findings */}
        {activeTab === 'answer' && (
          <div className="results-findings-view">
            {answer ? (
              <p className="results-panel-answer">{answer}</p>
            ) : (
              <p className="results-empty-state">No findings available for this query yet.</p>
            )}

            {(boxes.length > 0 || Object.keys(metrics).length > 0 || Object.keys(modelMetadata).length > 0 || severity) && (
              <div className="intel-cards-grid">
                {severity && (
                  <div className={`intel-severity-banner severity-${severity.level || 'medium'}`}>
                    <div className="severity-badge">{severity.label || severity.level || 'INFO'}</div>
                    {severity.description && <span className="severity-sub">{severity.description}</span>}
                  </div>
                )}

                {boxes.length > 0 && (
                  <div className="intel-card">
                    <span className="intel-card-label">KEY TARGET DETECTIONS</span>
                    <ul className="intel-detections-list">
                      {boxes.map((b) => (
                        <li key={b.id} className="intel-detection-item">
                          <span className="detection-name">{b.label}</span>
                          {b.confidence && <span className="detection-conf-badge">{b.confidence}</span>}
                          {b.area && <span className="detection-area">{b.area}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {Object.entries(metrics).length > 0 && (
                  <div className="intel-card">
                    <span className="intel-card-label">SPATIAL METRICS & BOUNDS</span>
                    <div className="intel-metrics-rows">
                      {Object.entries(metrics).map(([key, value]) => (
                        <div key={key} className="metric-row">
                          <span className="metric-name">{key}:</span>
                          <span className="metric-val">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Object.entries(modelMetadata).length > 0 && (
                  <div className="intel-card">
                    <span className="intel-card-label">MODEL PIPELINE METADATA</span>
                    <div className="intel-metrics-rows">
                      {Object.entries(modelMetadata).map(([key, value]) => (
                        <div key={key} className="metric-row">
                          <span className="metric-name">{key}:</span>
                          <span className="metric-val">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Trend */}
        {activeTab === 'trend' && (
          <div className="results-trend-view">
            {trendData ? (
              <TrendChart data={trendData} />
            ) : (
              <p className="results-empty-state">No trend data available for this query yet.</p>
            )}
          </div>
        )}

        {/* Tab 4: Execution Trace */}
        {activeTab === 'trace' && (
          <div className="results-trace-view">
            {steps.length > 0 ? (
              <div className="trace-stepper">
                {steps.map((s, i) => (
                  <div key={s.step ?? i} className="trace-step-item">
                    <div className="trace-step-icon">✓</div>
                    <div className="trace-step-content">
                      <div className="trace-step-header">
                        <span className="trace-step-title">{s.title || s.step || 'Step'}</span>
                        {s.latency && <span className="trace-step-latency">{s.latency}</span>}
                      </div>
                      {s.desc && <div className="trace-step-desc">{s.desc}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="results-empty-state">No execution trace recorded for this query yet.</p>
            )}
          </div>
        )}
      </div>

      {/* Meta Footer */}
      <div className="results-panel-meta">
        <span className="results-meta-item">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {hasResult ? 'Just now' : 'Waiting for analysis'}
        </span>
        <span className="results-meta-item">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          Active Coordinates
        </span>
      </div>
    </div>
  );
}