import { useState } from 'react';
import TrendChart from './TrendChart';

const STATUS_ORDER = { success: 0, partial: 1, failed: 2, rejected: 3 };

function formatTime(timestamp) {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour12: false });
  } catch {
    return null;
  }
}

function safeSummary(result) {
  if (result === null || result === undefined) return 'No result.';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (Array.isArray(result)) return `${result.length} entries`;
  if (typeof result === 'object') {
    for (const key of ['answer', 'caption', 'summary', 'note', 'error']) {
      const value = result[key];
      if (value !== undefined && value !== null && typeof value === 'string') return value;
    }
    const json = JSON.stringify(result);
    return json && json.length > 260 ? `${json.slice(0, 260)}…` : (json || '{}');
  }
  return String(result);
}

const STRINGIFIED_OBJECT = /^\[object (Object|Undefined|Null)\]$/;

const EVIDENCE_IMAGE_KEYS = [
  'filename',
  'filePath',
  'modality',
  'tileId',
  'tile_id',
  '_id',
  'id',
  'name',
  'label',
  'url',
  'path',
];

function evidenceImageLabel(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (!s) return null;
    return STRINGIFIED_OBJECT.test(s) ? 'Image reference' : s;
  }
  if (typeof entry === 'object') {
    for (const key of EVIDENCE_IMAGE_KEYS) {
      const value = entry[key];
      if (value === null || value === undefined) continue;
      const s = String(value).trim();
      if (s && !STRINGIFIED_OBJECT.test(s)) return s;
    }
    return 'Image reference';
  }
  const s = String(entry).trim();
  return s && !STRINGIFIED_OBJECT.test(s) ? s : null;
}

function ToolResultRow({ tool }) {
  return (
    <div className="result-tool">
      <span className="result-tool-name">{tool && tool.tool ? tool.tool : 'tool'}</span>
      <span className={`result-status status-${tool ? tool.status : 'failed'}`}>
        {tool ? tool.status : 'failed'}
      </span>
      <span className="result-tool-summary">{safeSummary(tool && tool.result)}</span>
    </div>
  );
}

export default function ResultPanel({ response }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const status = response && response.status ? response.status : 'unknown';
  const taskType = response && response.taskType ? response.taskType : 'Result';
  const confidence = typeof response?.confidence === 'number' ? response.confidence : null;
  const evidence = response?.evidence;
  const hasEvidence = evidence && (Array.isArray(evidence.images) ? evidence.images.length > 0 : false) ||
    (typeof evidence?.notes === 'string' && evidence.notes.length > 0);
  const signals = Array.isArray(response?.confidenceSignals) ? response.confidenceSignals : [];
  const trace = Array.isArray(response?.executionTrace) ? response.executionTrace : [];
  const tools = Array.isArray(response?.toolResults) ? response.toolResults : [];
  const topResult = response && response.result !== undefined ? response.result : null;

  const sortedTools = [...tools].sort((a, b) => {
    const sa = STATUS_ORDER[a && a.status] !== undefined ? STATUS_ORDER[a && a.status] : 9;
    const sb = STATUS_ORDER[b && b.status] !== undefined ? STATUS_ORDER[b && b.status] : 9;
    return sa - sb;
  });

  return (
    <div className={`search-result ${isFullscreen ? 'fullscreen' : ''}`}>
      <div className="search-result-header">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className="search-result-query">{taskType}</span>
        <span className={`result-status status-${status}`}>{status}</span>
        {confidence !== null && (
          <span className="search-result-confidence">{Math.round(confidence * 100)}% conf</span>
        )}
        <button 
          className="results-panel-fullscreen-btn" 
          onClick={() => setIsFullscreen(!isFullscreen)} 
          title={isFullscreen ? 'Downsize / Exit Fullscreen' : 'Fullscreen'}
          style={{ marginLeft: 'auto' }}
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
      </div>

      <p className="result-answer">{response && response.answerText ? response.answerText : 'No answer.'}</p>

      {(taskType?.toUpperCase() === 'TREND' || taskType?.toUpperCase() === 'CHANGE_DETECTION' || response?.trendData) && (
        <div className="result-section">
          <h4>Trend Visualization</h4>
          <TrendChart data={response?.trendData || response?.result?.trendData} />
        </div>
      )}

      {hasEvidence && (
        <div className="result-section">
          <h4>Evidence</h4>
          {Array.isArray(evidence.images) && evidence.images.length > 0 && (
            <div className="result-evidence-images">
              {evidence.images.map((id, i) => {
                const label = evidenceImageLabel(id);
                return label === null ? null : (
                  <span key={`evidence-img-${i}`} className="result-evidence-img">{label}</span>
                );
              })}
            </div>
          )}
          {typeof evidence.notes === 'string' && evidence.notes.length > 0 && (
            <p className="result-evidence-notes">{evidence.notes}</p>
          )}
        </div>
      )}

      {signals.length > 0 && (
        <div className="result-section">
          <h4>Confidence signals</h4>
          <ul className="result-signals">
            {signals.map((signal, i) => (
              <li key={i}>{signal}</li>
            ))}
          </ul>
        </div>
      )}

      {trace.length > 0 && (
        <details className="result-section result-details">
          <summary>Execution trace ({trace.length})</summary>
          <ol className="result-trace">
            {trace.map((step, i) => (
              <li key={`${step && step.step}-${i}`}>
                <span className="result-trace-step">{step && step.step}</span>
                {step && step.detail ? <span className="result-trace-detail"> — {step.detail}</span> : null}
                {formatTime(step && step.timestamp) ? (
                  <span className="result-trace-time"> {formatTime(step.timestamp)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      )}

      {tools.length > 0 && (
        <details className="result-section result-details">
          <summary>Tools ({tools.length})</summary>
          <div className="result-tools">
            {sortedTools.map((t, i) => (
              <ToolResultRow key={`${t && t.tool}-${i}`} tool={t} />
            ))}
          </div>
        </details>
      )}

      {tools.length === 0 && topResult && typeof topResult === 'object' && Object.keys(topResult).length > 0 && (
        <div className="result-section">
          <h4>Result</h4>
          <p className="result-evidence-notes">{safeSummary(topResult)}</p>
        </div>
      )}
    </div>
  );
}