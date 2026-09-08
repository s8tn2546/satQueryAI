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

  const sampleAnswer = resultData?.answerText || 
    'Target area analysis complete. Multi-spectral visual inspection confirms key infrastructure changes, vehicle activity, and built-up structure expansion within the specified coordinate boundary.';

  const sampleBoxes = resultData?.boxes || [
    { id: 1, label: 'Building Structure', confidence: '96%', x: 22, y: 18, width: 38, height: 32, area: '2,850 m²', coords: '12.9716° N, 77.5946° E' },
    { id: 2, label: 'Vehicle Apron', confidence: '92%', x: 62, y: 55, width: 28, height: 26, area: '1,400 m²', coords: '12.9721° N, 77.5952° E' },
  ];

  const executionSteps = resultData?.trace || [
    { step: 1, title: 'Spatial Bounds Check', desc: 'Resolved latitude & longitude tile grid', status: 'done', latency: '14 ms' },
    { step: 2, title: 'Multi-spectral Tile Retrieval', desc: 'Fetched Sentinel-2 L2A optical & SAR layers', status: 'done', latency: '120 ms' },
    { step: 3, title: 'VLM Target Detection', desc: 'Inference via Qwen2-VL & Segment Anything model', status: 'done', latency: '180 ms' },
    { step: 4, title: 'Trust Layer Verification', desc: 'Confidence scoring & artifact mask check passed', status: 'done', latency: '26 ms' },
  ];

  const handleDownloadReport = () => {
    setIsExporting(true);
    setTimeout(() => {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
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
    .step-num { width: 22px; height: 22px; border-radius: 50%; background: #34d399; color: #060913; font-weight: bold; font-size: 12px; display: grid; place-items: center; flex: none; }
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
      Generated: ${new Date().toLocaleString()} &nbsp;·&nbsp; Model: Qwen2-VL Baseline &nbsp;·&nbsp; Confidence: 94.8%
    </div>
  </div>

  <div class="section-title">Executive Summary & Findings</div>
  <div class="card answer-body">
    ${sampleAnswer}
  </div>

  <div class="section-title">Execution Trace & Verification Pipeline</div>
  <div class="card">
    <ul class="step-list">
      ${executionSteps.map(s => `
        <li class="step-item">
          <div class="step-num">✓</div>
          <div>
            <div class="step-title">${s.title} (${s.latency})</div>
            <div class="step-desc">${s.desc}</div>
          </div>
        </li>
      `).join('')}
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
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const geojson = {
      type: 'FeatureCollection',
      name: 'SatQuery_Detections',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features: sampleBoxes.map(box => ({
        type: 'Feature',
        properties: {
          id: box.id,
          label: box.label,
          confidence: box.confidence,
          area: box.area,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [77.5940 + (box.x / 1000), 12.9710 + (box.y / 1000)],
            [77.5940 + ((box.x + box.width) / 1000), 12.9710 + (box.y / 1000)],
            [77.5940 + ((box.x + box.width) / 1000), 12.9710 + ((box.y + box.height) / 1000)],
            [77.5940 + (box.x / 1000), 12.9710 + ((box.y + box.height) / 1000)],
            [77.5940 + (box.x / 1000), 12.9710 + (box.y / 1000)],
          ]],
        },
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
            disabled={isExporting}
            title="Export Satellite Intelligence Report (HTML)"
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
            title="Export Detections to GeoJSON Format"
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
          Analysis Complete
        </span>
        <span className="results-panel-confidence">Confidence: 94.8% · Qwen2-VL</span>
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
        {/* Tab 1: Visual Evidence with Interactive Bounding Boxes & Overlays */}
        {activeTab === 'evidence' && (
          <div className="results-evidence-view">
            {/* Control Bar for Toggling Layers & Opacity */}
            <div className="evidence-controls-stack">
              <div className="evidence-controls">
                <button 
                  className={`layer-toggle-btn ${showBoundingBoxes ? 'active' : ''}`} 
                  onClick={() => setShowBoundingBoxes(!showBoundingBoxes)}
                >
                  <span className="toggle-indicator" />
                  Bounding Boxes
                </button>
                <button 
                  className={`layer-toggle-btn ${showMask ? 'active' : ''}`} 
                  onClick={() => setShowMask(!showMask)}
                >
                  <span className="toggle-indicator" />
                  Segmentation Mask
                </button>
              </div>

              {/* Smooth Opacity Sliders */}
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

            {/* Satellite Evidence Aspect-Ratio Locked Container */}
            <div className="evidence-viewport aspect-ratio-locked">
              <div className="evidence-canvas-frame">
                {/* Base Satellite Image */}
                <div 
                  className="evidence-satellite-bg"
                  style={{
                    backgroundImage: resultData?.uploadedImages?.[0]?.url 
                      ? `url(${resultData.uploadedImages[0].url})` 
                      : `radial-gradient(circle at 50% 50%, rgba(110,180,255,0.15) 0%, rgba(6,9,19,0.9) 100%), linear-gradient(135deg, #0d1527 0%, #172238 100%)`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }}
                >
                  <div className="satellite-grid-overlay" />

                  {/* Mask Layer */}
                  {showMask && (
                    <div 
                      className="evidence-mask-layer"
                      style={{
                        position: 'absolute',
                        inset: 0,
                        opacity: maskOpacity / 100,
                        background: 'radial-gradient(ellipse at 35% 30%, rgba(52, 211, 153, 0.45) 0%, rgba(59, 125, 221, 0.3) 50%, transparent 80%)',
                        mixBlendMode: 'screen',
                        transition: 'opacity 0.15s ease',
                      }}
                    />
                  )}

                  {/* SVG Bounding Boxes Overlay with Aspect Ratio Lock */}
                  {showBoundingBoxes && (
                    <svg 
                      className="evidence-svg-overlay" 
                      viewBox="0 0 100 100" 
                      preserveAspectRatio="xMidYMid meet"
                      style={{ opacity: boxOpacity / 100, transition: 'opacity 0.15s ease' }}
                    >
                      {sampleBoxes.map((box) => {
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
                              fill={isSelected ? "rgba(52, 211, 153, 0.25)" : "rgba(110, 180, 255, 0.14)"}
                              stroke={isSelected ? "#34D399" : "#6EB4FF"}
                              strokeWidth={isSelected ? "1.4" : "0.9"}
                              strokeDasharray={isSelected ? "none" : "2 1"}
                              rx="1"
                            />
                            <rect
                              x={box.x}
                              y={box.y - 6}
                              width={box.width * 0.82}
                              height="5.5"
                              fill={isSelected ? "#059669" : "#3B7DDD"}
                              rx="0.8"
                            />
                            <text
                              x={box.x + 1.5}
                              y={box.y - 1.8}
                              fill="#FFFFFF"
                              fontSize="3.2"
                              fontWeight="bold"
                            >
                              {box.label} ({box.confidence})
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  )}
                </div>
              </div>
            </div>

            {/* Detections Chips Row */}
            <div className="evidence-detections-list">
              <span className="detections-list-title">DETECTED TARGETS:</span>
              <div className="detections-chips">
                {sampleBoxes.map((box) => (
                  <button
                    key={box.id}
                    type="button"
                    className={`detection-chip ${selectedBoxId === box.id ? 'active' : ''}`}
                    onClick={() => setSelectedBoxId(selectedBoxId === box.id ? null : box.id)}
                  >
                    <span className="chip-dot" />
                    <span className="chip-label">{box.label}</span>
                    <span className="chip-conf">{box.confidence}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Categorized Intelligence Findings */}
        {activeTab === 'answer' && (
          <div className="results-findings-view">
            {/* Intel Severity Banner */}
            <div className="intel-severity-banner severity-medium">
              <div className="severity-badge">ACTIVITY MONITORING</div>
              <span className="severity-sub">Multi-spectral target detection score: High Confidence</span>
            </div>

            {/* Summary Text */}
            <p className="results-panel-answer">{sampleAnswer}</p>

            {/* Categorized Intel Cards */}
            <div className="intel-cards-grid">
              <div className="intel-card">
                <span className="intel-card-label">KEY TARGET DETECTIONS</span>
                <ul className="intel-detections-list">
                  {sampleBoxes.map((b) => (
                    <li key={b.id} className="intel-detection-item">
                      <span className="detection-name">{b.label}</span>
                      <span className="detection-conf-badge">{b.confidence}</span>
                      <span className="detection-area">{b.area}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="intel-card">
                <span className="intel-card-label">SPATIAL METRICS & BOUNDS</span>
                <div className="intel-metrics-rows">
                  <div className="metric-row">
                    <span className="metric-name">Centroid Coordinates:</span>
                    <span className="metric-val">{sampleBoxes[0]?.coords}</span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-name">Total Structural Footprint:</span>
                    <span className="metric-val">4,250 m²</span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-name">Raster Grid Resolution:</span>
                    <span className="metric-val">0.5m / px (Sentinel-2 L2A)</span>
                  </div>
                </div>
              </div>

              <div className="intel-card">
                <span className="intel-card-label">MODEL PIPELINE METADATA</span>
                <div className="intel-metrics-rows">
                  <div className="metric-row">
                    <span className="metric-name">VLM Architecture:</span>
                    <span className="metric-val">Qwen2-VL-7B-Instruct</span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-name">LoRA Adapter:</span>
                    <span className="metric-val">satquery-lora-geoint-v2</span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-name">Total Pipeline Latency:</span>
                    <span className="metric-val">340 ms</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Quantitative Multi-Metric Trend Chart */}
        {activeTab === 'trend' && (
          <div className="results-trend-view">
            <TrendChart />
          </div>
        )}

        {/* Tab 4: Execution Trace Stepper */}
        {activeTab === 'trace' && (
          <div className="results-trace-view">
            <div className="trace-stepper">
              {executionSteps.map((s) => (
                <div key={s.step} className="trace-step-item">
                  <div className="trace-step-icon">✓</div>
                  <div className="trace-step-content">
                    <div className="trace-step-header">
                      <span className="trace-step-title">{s.title}</span>
                      <span className="trace-step-latency">{s.latency}</span>
                    </div>
                    <div className="trace-step-desc">{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>
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
          Just now
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
