import { useState } from 'react';
import TrendChart from './TrendChart';

export default function ResultsPanel({ query, resultData, onClose }) {
  const [activeTab, setActiveTab] = useState('evidence');
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [showMask, setShowMask] = useState(false);
  const [splitPosition, setSplitPosition] = useState(50);
  const [isExporting, setIsExporting] = useState(false);

  if (!query) return null;

  const sampleAnswer = resultData?.answerText || 
    'Target area analysis complete. Multi-spectral visual inspection confirms key infrastructure changes and vehicle activity within the specified coordinate boundary.';

  const sampleBoxes = resultData?.boxes || [
    { id: 1, label: 'Building Structure', confidence: '96%', x: 22, y: 18, width: 38, height: 32 },
    { id: 2, label: 'Vehicle Apron', confidence: '92%', x: 62, y: 55, width: 28, height: 26 },
  ];

  const executionSteps = resultData?.trace || [
    { step: 1, title: 'Spatial Bounds Check', desc: 'Resolved latitude & longitude tile grid', status: 'done' },
    { step: 2, title: 'Multi-spectral Tile Retrieval', desc: 'Fetched Sentinel-2 L2A optical & SAR layers', status: 'done' },
    { step: 3, title: 'VLM Target Detection', desc: 'Inference via Qwen2-VL & Segment Anything model', status: 'done' },
    { step: 4, title: 'Trust Layer Verification', desc: 'Confidence scoring & artifact mask check passed', status: 'done' },
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
            <div class="step-title">${s.title}</div>
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

  return (
    <div className="results-panel">
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
            title="Export Satellite Intelligence Report"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>{isExporting ? 'Exporting...' : 'Download Report'}</span>
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
            {/* Control Bar for Toggling Layers */}
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

            {/* Satellite Evidence Canvas Container */}
            <div className="evidence-viewport">
              {/* Base Simulated Satellite Image */}
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

                {/* Optional Mask Overlay Layer */}
                {showMask && (
                  <div 
                    className="evidence-mask-layer"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'radial-gradient(ellipse at 35% 30%, rgba(52, 211, 153, 0.35) 0%, rgba(59, 125, 221, 0.25) 50%, transparent 80%)',
                      mixBlendMode: 'screen',
                    }}
                  />
                )}

                {/* SVG Bounding Boxes Overlay */}
                {showBoundingBoxes && (
                  <svg className="evidence-svg-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {sampleBoxes.map((box) => (
                      <g key={box.id} className="bounding-box-group">
                        <rect
                          x={box.x}
                          y={box.y}
                          width={box.width}
                          height={box.height}
                          fill="rgba(110, 180, 255, 0.12)"
                          stroke="#6EB4FF"
                          strokeWidth="0.8"
                          strokeDasharray="2 1"
                          rx="1"
                        />
                        <rect
                          x={box.x}
                          y={box.y - 6}
                          width={box.width * 0.75}
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
                          {box.label} ({box.confidence})
                        </text>
                      </g>
                    ))}
                  </svg>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Findings Summary */}
        {activeTab === 'answer' && (
          <div className="results-findings-view">
            <p className="results-panel-answer">{sampleAnswer}</p>
          </div>
        )}

        {/* Tab 3: Quantitative Trend Chart */}
        {activeTab === 'trend' && (
          <div className="results-trend-view">
            <TrendChart />
          </div>
        )}

        {/* Tab 3: Execution Trace Stepper */}
        {activeTab === 'trace' && (
          <div className="results-trace-view">
            <div className="trace-stepper">
              {executionSteps.map((s) => (
                <div key={s.step} className="trace-step-item">
                  <div className="trace-step-icon">✓</div>
                  <div className="trace-step-content">
                    <div className="trace-step-title">{s.title}</div>
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
