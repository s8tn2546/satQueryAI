import { useState, useEffect } from 'react';
import TrendChart from './TrendChart';
import { fetchTile, tileImageUrl } from '../services/api';
import {
  buildFindings,
  buildTrendState,
  toolConfidence,
  primaryToolName,
  rawVqaAnswer,
  isFiniteNumber,
  traceLabel
} from '../lib/results';

const TOOL_LABELS = {
  vqa: 'Visual QA',
  caption: 'Captioning',
  ground: 'Grounding',
  change: 'Change detection',
  optical_sar: 'Optical + SAR fusion',
  ndvi: 'NDVI',
  ndwi: 'NDWI',
  area: 'Area',
  trend: 'Trend'
};

// Minimal HTML escaping for locally generated report content.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCoord(v) {
  return isFiniteNumber(v) ? Number(v).toFixed(4) : '—';
}

// A raster is georeferenced only when actual CRS/geographic bounds metadata is
// present. Absence of that metadata must never be presented as georeferenced.
function hasSpatialReference(meta) {
  return Boolean(meta && (meta.crs || meta.bounds || meta.wgs84_bounds));
}

export default function ResultsPanel({ query, resultData, onClose, isAnalyzing = false, onInvestigatePeriod }) {
  const [activeTab, setActiveTab] = useState('evidence');
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [showMask, setShowMask] = useState(false);
  const [boxOpacity, setBoxOpacity] = useState(100);
  const [maskOpacity, setMaskOpacity] = useState(60);
  const [selectedBoxId, setSelectedBoxId] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tileInfos, setTileInfos] = useState({});
  const [elapsedSec, setElapsedSec] = useState(0);
  const [prevAnalyzing, setPrevAnalyzing] = useState(isAnalyzing);
  const [isCompareMode, setIsCompareMode] = useState(false);
  const [swipePos, setSwipePos] = useState(50);

  // Reset the elapsed timer exactly when a new analyzing session starts, and
  // clear it once it ends. State is adjusted during render (the documented
  // "adjusting state when props change" pattern) — no setState inside the
  // effect body.
  if (isAnalyzing && !prevAnalyzing) {
    setPrevAnalyzing(true);
    setElapsedSec(0);
  }
  if (!isAnalyzing && prevAnalyzing) {
    setPrevAnalyzing(false);
  }

  // Factual elapsed timer shown while a request is pending. No fake progress:
  // it simply measures how long the analysis has been running.
  useEffect(() => {
    if (!isAnalyzing) return;
    const timer = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [isAnalyzing]);

  const taskType = resultData?.taskType || null;
  const answerText = resultData?.answerText || '';
  const boxes = Array.isArray(resultData?.boxes) ? resultData.boxes : [];
  const toolResults = Array.isArray(resultData?.toolResults) ? resultData.toolResults : [];
  const imageRefs = Array.isArray(resultData?.imageRefs) ? resultData.imageRefs.filter(Boolean) : [];
  const evidence = resultData?.evidence && typeof resultData.evidence === 'object' ? resultData.evidence : {};
  const parameters = resultData?.parameters && typeof resultData.parameters === 'object' ? resultData.parameters : {};
  const rawSteps = Array.isArray(resultData?.trace)
    ? resultData.trace
    : Array.isArray(resultData?.executionTrace)
      ? resultData.executionTrace
      : [];
  // Display traces through the existing traceLabel() normalizer so each step
  // gets a real number + title (mirror steps collapsed). The raw trace is kept
  // for the JSON export so no fidelity is lost there.
  const steps = traceLabel(rawSteps);
  const imageT1Url = resultData?.uploadedImages?.[0]?.url || resultData?.imageT1 || '';
  const imageT2Url = resultData?.uploadedImages?.[1]?.url || resultData?.imageT2 || '';
  const imageUrl = imageT1Url || imageT2Url || (resultData?.uploadedImages?.[0]?.url || '');
  const hasTwoImages = Boolean(imageT1Url && imageT2Url);
  // Browsers cannot render TIFF previews, so the interactive T1/T2 Swipe /
  // Opacity viewport is only available when both uploaded previews are
  // browser-renderable (PNG/JPEG). TIFF pairs keep the labelled source cards.
  const uploadPreviewName = (i) => {
    const u = (resultData?.uploadedImages && resultData.uploadedImages[i]) || {};
    return u.name || (u.file && u.file.name) || '';
  };
  const renderablePair = hasTwoImages && Array.isArray(resultData?.uploadedImages)
    && resultData.uploadedImages.length >= 2
    && [0, 1].every((i) => /\.(png|jpe?g|webp)$/i.test(uploadPreviewName(i)));
  const trendData = resultData?.trendData || null;
  const metrics = resultData?.metrics || {};
  const modelMetadata = resultData?.modelMetadata || {};
  const severity = resultData?.severity || null;

  // Scene validation metadata, resolved from persisted tiles (publicTile now
  // exposes the full /validate metadata object per image).
  const sceneEntries = imageRefs.map((id) => {
    const info = tileInfos[id] || null;
    const meta = info && info.metadata && typeof info.metadata === 'object' ? info.metadata : null;
    const hasBands = Boolean(meta && Array.isArray(meta.bands) && meta.bands.length > 0);
    const hasSceneInfo = Boolean(meta && (
      meta.crs || meta.bounds || meta.wgs84_bounds || meta.resolution || meta.width || meta.height
      || meta.band_count || meta.dtype || meta.nodata !== undefined || hasBands
    ));
    const res = meta && meta.resolution && isFiniteNumber(meta.resolution.x) && isFiniteNumber(meta.resolution.y)
      ? meta.resolution : null;
    const dims = meta && isFiniteNumber(meta.width) && isFiniteNumber(meta.height)
      ? { width: meta.width, height: meta.height } : null;
    return {
      id, info, meta, hasBands, hasSceneInfo,
      name: (info && (info.name || info.filename)) || String(id).slice(0, 8),
      crs: meta?.crs || null,
      bands: hasBands ? meta.bands.length : null,
      bandIds: hasBands ? meta.bands.map((b) => b?.index ?? b?.detected_name ?? '?') : [],
      format: meta && meta.format ? String(meta.format) : null,
      georeferenced: hasSpatialReference(meta),
      warnings: meta && Array.isArray(meta.warnings) ? meta.warnings : [],
      resolution: res,
      dimensions: dims,
      valid: meta ? !(meta.valid === false || meta.validation_status === 'invalid') : null,
    };
  });
  const sceneMetadataVisible = sceneEntries.some((e) => e.hasSceneInfo);
  const anySceneMeta = sceneEntries.some((e) => e.meta);
  const anyGeoreferenced = sceneEntries.some((e) => e.georeferenced);

  // Resolve persisted tile metadata so History restores the same source imagery.
  const imageRefKey = imageRefs.join('|');
  useEffect(() => {
    let cancelled = false;
    if (imageRefs.length === 0) return undefined;
    Promise.all(imageRefs.map(async (id) => {
      try {
        return { id, info: await fetchTile(id) };
      } catch {
        return { id, info: { _id: id, error: true } };
      }
    })).then((entries) => {
      if (!cancelled) {
        setTileInfos(Object.fromEntries(entries.map(({ id, info }) => [id, info])));
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageRefKey]);

  const findings = buildFindings({
    taskType,
    answerText,
    toolResults,
    query,
    status: resultData?.status
  });
  const trendState = buildTrendState({ taskType, toolResults, trendData, parameters });

  const primaryTool = primaryToolName(taskType);
  const primaryToolConf = toolConfidence(toolResults, primaryTool);

  // --- Pending-analysis stage view ------------------------------------------
  // States are derived from facts we actually know mid-flight: the request is
  // in the pipeline (query received), images uploaded/validated on ingest
  // (image refs exist), and the model is genuinely executing. Steps that are
  // unknowable before the response arrives stay pending — never faked.
  const imageReady = imageRefs.length > 0;
  const analysisStages = [
    { id: 'query', label: 'Query understood', state: 'done' },
    { id: 'image', label: 'Image validated', state: imageReady ? 'done' : 'pending' },
    { id: 'plan', label: 'Analysis plan prepared', state: 'pending' },
    { id: 'infer', label: 'Running visual analysis', state: 'active' },
    { id: 'result', label: 'Preparing result', state: 'pending' },
  ];
  const elapsedLabel =
    `${String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`;

  // --- Evidence-context data from real returned values ----------------------
  const firstTileInfo = imageRefs.map((id) => tileInfos[id]).find(Boolean) || null;
  const inputType = firstTileInfo && firstTileInfo.format ? firstTileInfo.format.toUpperCase() : null;
  const modalityLabel = firstTileInfo && firstTileInfo.modality
    ? (firstTileInfo.source ? `${firstTileInfo.modality.toUpperCase()} · ${firstTileInfo.source}` : firstTileInfo.modality.toUpperCase())
    : null;
  const modelName = findings.modelName;

  const changeToolResult = (() => {
    const ch = toolResults.find((t) => t && t.tool === 'change' && t.status === 'success');
    return ch && ch.result && typeof ch.result === 'object' ? ch.result : null;
  })();
  const changePct = changeToolResult
    ? (isFiniteNumber(changeToolResult.change_percentage) ? changeToolResult.change_percentage
      : isFiniteNumber(changeToolResult.changePercentage) ? changeToolResult.changePercentage : null)
    : null;

  const confidence = resultData?.confidence != null
    ? `${(Number(resultData.confidence) * 100).toFixed(1)}%`
    : null;

  // Only finished analysis artifacts count as a result. A bare uploaded-image
  // preview while a request is still pending must NOT read as "Analysis
  // Complete".
  const hasResult = !isAnalyzing && Boolean(answerText || boxes.length || steps.length || imageRefs.length);

  const status = resultData?.status;
  const statusClass = isAnalyzing
    ? 'analyzing'
    : status === 'failed' ? 'failed' :
      status === 'rejected' ? 'rejected' :
      status === 'partial' ? 'partial' : 'ready';

  // Successful single-scene VQA results carry their conclusion in the header
  // (buildFindings primary). The Findings tab surfaces that SAME canonical
  // output — never a second, independent VQA result — plus the factual
  // metadata already attached to the tool result. Defined after status /
  // confidence so there is no temporal-dead-zone reference.
  const vqaFinding = (taskType === 'VQA' && status !== 'failed' && status !== 'rejected' && findings.primary)
    ? {
        primary: findings.primary,
        context: findings.explanation,
        question: query,
        model: findings.modelName,
        adapter: findings.adapterActive,
        hasAdapterInfo: findings.adapterActive !== null,
        tool: primaryTool ? (TOOL_LABELS[primaryTool] || primaryTool) : null,
        toolConf: primaryToolConf,
        confidence,
        inputType,
        modalityLabel
      }
    : null;

  const statusLabel = isAnalyzing
    ? 'Analyzing'
    : status === 'failed' ? 'Analysis Failed' :
      status === 'rejected' ? 'Query Rejected' :
      status === 'partial' ? 'Partial Analysis' :
      (hasResult ? 'Analysis Complete' : 'Awaiting Data');
  const isMock = Boolean(resultData?.isMockResult) || answerText === 'offline-placeholder';
  const rawAnswer = rawVqaAnswer(toolResults, answerText);

  // Data Quality status always mirrors the real analysis outcome: a failed or
  // rejected query must never read as "READY_FOR_ANALYSIS". The backend's
  // qualityReport is authoritative when present; otherwise status drives it.
  const qualityReport = resultData?.qualityReport || null;
  const qualityStatus = qualityReport?.status || (
    status === 'failed' || status === 'rejected' ? 'CANNOT_ANALYZE'
      : status === 'partial' ? 'ANALYSIS_WARNING'
        : 'READY_FOR_ANALYSIS'
  );

  // A VQA query over an unreferenced PNG/JPEG is analysis-ready for VISUAL
  // work, but it is factually NOT georeferenced and has NO usable
  // CRS/resolution/bounds. Surface that distinction honestly while leaving
  // the underlying status semantics unchanged for geospatial tasks.
  const visualOnlyReady = qualityStatus === 'READY_FOR_ANALYSIS' && taskType === 'VQA' && anySceneMeta && !anyGeoreferenced;
  const qualityStatusLabel = qualityStatus === 'CANNOT_ANALYZE'
    ? 'CANNOT ANALYZE'
    : qualityStatus === 'ANALYSIS_WARNING'
      ? 'ANALYSIS WARNING'
      : visualOnlyReady
        ? 'READY FOR VISUAL ANALYSIS'
        : 'READY FOR ANALYSIS';
  const qualitySummary = visualOnlyReady
    ? 'Raster validated and ready for visual analysis. No CRS/transform metadata was provided — georeferencing, spatial resolution and geographic bounds are not available.'
    : qualityReport?.summary || null;

  // Build Data Quality checks from the resolved tile metadata (authoritative
  // facts), not from assertions. A non-georeferenced PNG therefore shows
  // "Georeferencing & CRS -> NOT AVAILABLE" instead of a fabricated PASS, while
  // a real GeoTIFF keeps its actual CRS/resolution/bounds. Backend checks that
  // are not covered by the fact sheet are preserved.
  const buildDataQualityChecks = (scenes) => {
    if (!scenes.length) return null;
    const first = scenes[0];
    const count = scenes.length;
    const bandWarn = (first.warnings || []).find((w) => /band desc/i.test(w));
    const na = 'NOT_AVAILABLE';
    const checks = [
      {
        name: 'Raster Format & Readability',
        status: 'PASS',
        details: `All ${count} tile(s) readable in ${first.format ? first.format.toUpperCase() : 'supported raster'} format.`
      },
      first.georeferenced
        ? {
            name: 'Georeferencing & CRS',
            status: 'PASS',
            details: `Georeferenced${first.crs ? ` in ${first.crs}` : ''}; spatial bounds match coordinate framework.`
          }
        : {
            name: 'Georeferencing & CRS',
            status: na,
            details: 'No CRS/transform metadata provided — image is not georeferenced. Geospatial operations are unavailable (visual analysis is unaffected).'
          },
      first.resolution
        ? { name: 'Spatial Resolution', status: 'PASS', details: `${first.resolution.x} × ${first.resolution.y} m per pixel.` }
        : { name: 'Spatial Resolution', status: na, details: 'No ground sample distance / resolution metadata provided.' },
      first.bands
        ? { name: 'Band Availability', status: 'PASS', details: `${first.bands} spectral channel(s) available${bandWarn ? ' — band identities not determinable from metadata alone' : ''}.` }
        : { name: 'Band Availability', status: 'LIMITED', details: 'Band metadata unavailable.' },
      first.dimensions
        ? { name: 'Image Dimensions', status: 'PASS', details: `${first.dimensions.width} × ${first.dimensions.height} px.` }
        : { name: 'Image Dimensions', status: na, details: 'No pixel dimensions provided.' }
    ];
    return checks;
  };

  const reportChecks = qualityReport?.checks && Array.isArray(qualityReport.checks) ? qualityReport.checks : [];
  const factualChecks = buildDataQualityChecks(sceneEntries) || [];
  for (const c of reportChecks) {
    if (!factualChecks.some((f) => f.name === c.name)) factualChecks.push(c);
  }
  // A hard-failed/rejected query must keep its failure presentation even when
  // tile metadata exists; the fact sheet only applies to analyses that ran.
  const qualityChecks = (qualityStatus === 'CANNOT_ANALYZE')
    ? [{ name: 'Analysis Completion', status: 'FAIL', details: answerText || 'Analysis could not be completed.' }]
    : factualChecks.length
      ? factualChecks
      : qualityStatus === 'ANALYSIS_WARNING'
        ? [{ name: 'Analysis Completion', status: 'WARN', details: answerText || 'Analysis completed with warnings.' }]
        : reportChecks;

  const handleDownloadReport = () => {
    if (!hasResult) return;
    setIsExporting(true);
    setTimeout(() => {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const stepRows = steps.length
        ? steps.map((s) => `
        <li class="step-item">
          <div class="step-num">${s.failed ? '!' : '✓'}</div>
          <div>
            <div class="step-title">${esc(s.number)} &middot; ${esc(s.title)}</div>
            <div class="step-desc">${esc(s.detail)}</div>
          </div>
        </li>
      `).join('')
        : '<li class="step-item"><div class="step-desc">No execution trace recorded.</div></li>';

      // Result measurements: only values actually returned by a successful tool.
      const resultRows = [];
      for (const tr of toolResults) {
        if (tr && (tr.status === 'success' || tr.status === 'partial') && tr.result && typeof tr.result === 'object') {
          const skip = new Set(['warnings', 'change_mask_path', 'change_mask_url', 'map_image_path', 'error']);
          const entries = Object.entries(tr.result).filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null);
          for (const [k, v] of entries.slice(0, 14)) {
            const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
            resultRows.push(`<tr><td class="k">${esc(TOOL_LABELS[tr.tool] || tr.tool)} · ${esc(k)}</td><td class="v">${esc(display)}</td></tr>`);
          }
        }
      }
      const metricsRows = Object.entries(metrics || {}).slice(0, 14)
        .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`);

      const qualityRows = (qualityChecks || []).map((c) =>
        `<li class="q-item"><span class="q-status ${esc((c.status || 'WARN').toLowerCase())}">${esc(c.status)}</span><span class="q-name">${esc(c.name)}</span><span class="q-detail">${esc(c.details)}</span></li>`
      ).join('');

      const aoiBlock = resultData?.roiAttachment && resultData.roiAttachment.bbox
        ? `
  <div class="section-title">AOI Scope</div>
  <div class="card">
    <div class="label">Region of Interest</div>
    <p class="query-text" style="font-size:15px;">${esc(resultData.roiAttachment.name || 'Drawn region')}</p>
    <div style="margin-top:10px; font-size:13px; color:#cbd5e1;">
      BBox (W, S, E, N): [${esc(resultData.roiAttachment.bbox.west)}, ${esc(resultData.roiAttachment.bbox.south)}, ${esc(resultData.roiAttachment.bbox.east)}, ${esc(resultData.roiAttachment.bbox.north)}]
    </div>
  </div>`
        : '';

      const evidenceBlock = `
  <div class="card">
    <div class="label">Evidence Sources</div>
    ${imageRefs.length ? `<ul class="src-list">${imageRefs.map((id) => {
      const info = tileInfos[id] || null;
      const label = info
        ? [info.modality && info.modality.toUpperCase(), info.source, info.format && info.format.toUpperCase()].filter(Boolean).join(' · ')
        : id;
      return `<li>${esc(label)} <span class="muted">${esc(id)}</span></li>`;
    }).join('')}</ul>` : '<div class="muted">No source imagery recorded.</div>'}
    ${evidence && evidence.notes ? `<p class="muted" style="margin-top:8px;">${esc(evidence.notes)}</p>` : ''}
  </div>`;

      const detectionsBlock = boxes.length
        ? `
  <div class="section-title">Detections</div>
  <div class="card">
    <ul class="src-list">
      ${boxes.map((b) => `<li><strong>${esc(b.label)}</strong>${b.confidence ? ` <span class="muted">conf ${esc(b.confidence)}</span>` : ''}${b.area ? ` <span class="muted">area ${esc(b.area)}</span>` : ''}</li>`).join('')}
    </ul>
  </div>` : '';

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
    .meta-grid { display: flex; flex-wrap: wrap; gap: 16px 32px; margin-top: 14px; font-size: 13px; color: #cbd5e1; }
    .meta-name { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #94a3b8; letter-spacing: 1px; display: block; }
    .meta-val { font-weight: 600; color: #f1f5f9; }
    .step-list, .src-list, .q-list { list-style: none; padding: 0; margin: 0; }
    .step-item, .q-item { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
    .step-num { width: 22px; height: 22px; border-radius: 50%; background: #3b7ddd; color: #ffffff; font-weight: bold; font-size: 12px; display: grid; place-items: center; flex: none; }
    .step-title { font-size: 14px; font-weight: 600; color: #f1f5f9; }
    .step-desc { font-size: 12px; color: #94a3b8; margin-top: 2px; }
    .q-status { font-size: 10px; font-weight: 800; text-transform: uppercase; border-radius: 6px; padding: 2px 8px; }
    .q-status.pass { background: rgba(16,185,129,0.18); color: #6ee7b7; }
    .q-status.warn { background: rgba(245,158,11,0.18); color: #fcd34d; }
    .q-status.fail { background: rgba(239,68,68,0.18); color: #fca5a5; }
    .q-name { font-size: 13px; font-weight: 600; color: #f1f5f9; width: 260px; flex: none; }
    .q-detail { font-size: 12px; color: #94a3b8; }
    .muted { color: #64748b; font-size: 12px; }
    .src-list li { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 13px; color: #cbd5e1; }
    .kv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .kv-table td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: top; }
    .kv-table td.k { color: #94a3b8; width: 45%; font-weight: 600; }
    .kv-table td.v { color: #e2e8f0; word-break: break-word; }
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
    <p class="query-text">"${esc(query)}"</p>
    <div class="meta-grid">
      ${taskType ? `<div><span class="meta-name">Task Type</span><span class="meta-val">${esc(taskType)}</span></div>` : ''}
      ${status ? `<div><span class="meta-name">Status</span><span class="meta-val">${esc(status)}</span></div>` : ''}
      ${confidence ? `<div><span class="meta-name">Overall Confidence</span><span class="meta-val">${esc(confidence)}</span></div>` : ''}
      <div><span class="meta-name">Generated</span><span class="meta-val">${new Date().toLocaleString()}</span></div>
    </div>
  </div>

  <div class="section-title">Executive Summary & Findings</div>
  <div class="card answer-body">
    ${esc(findings.primary || answerText || 'No findings available for this query.')}
    ${findings.explanation ? `<p style="margin:8px 0 0;color:#94a3b8;font-size:12px;">${esc(findings.explanation)}</p>` : ''}
  </div>

  <div class="section-title">Data Quality</div>
  <div class="card">
    <div class="label">Validation Status — ${esc(qualityStatus)}</div>
    ${qualityReport && qualityReport.summary ? `<p class="muted" style="margin-bottom:6px;">"${esc(qualityReport.summary)}"</p>` : ''}
    <ul class="q-list">
      ${qualityRows}
    </ul>
  </div>

  ${aoiBlock}

  <div class="section-title">Result Values</div>
  <div class="card">
    ${(resultRows.length || metricsRows.length) ? `<table class="kv-table">${resultRows.concat(metricsRows).join('')}</table>` : '<div class="muted">No quantitative values were returned for this query.</div>'}
  </div>

  ${detectionsBlock}

  ${evidenceBlock}

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

  // eslint-disable-next-line no-unused-vars
  const handleExportJSON = () => {
    if (!hasResult) return;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const jsonReport = {
      platform: 'SatQuery AI Earth Intelligence Platform',
      query,
      timestamp: new Date().toISOString(),
      findings: answerText,
      confidence: resultData?.confidence || 0,
      qualityReport: resultData?.qualityReport || null,
      roi: resultData?.roiAttachment || null,
      metrics,
      modelMetadata,
      detections: boxes,
      executionTrace: rawSteps
    };
    const blob = new Blob([JSON.stringify(jsonReport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SatQuery_Report_${timestamp}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // eslint-disable-next-line no-unused-vars
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

  // --- Evidence card helpers ------------------------------------------------

  function sourceCardTitle(info) {
    if (taskType === 'CHANGE_ANALYSIS') {
      return Array.isArray(imageRefs) && info && imageRefs[0] === String(info._id) ? 'Before capture' : 'After capture';
    }
    if (taskType === 'OPTICAL_SAR') {
      return info && info.modality === 'sar' ? 'SAR source' : 'Optical source';
    }
    return 'Source imagery';
  }

  function sourceSubtitle(info) {
    const parts = [];
    if (info) {
      if (info.source === 'benchmark-upload') parts.push('Uploaded satellite imagery');
      else if (info.source) parts.push(`Source: ${info.source}`);
      if (info.modality) parts.push(info.modality.toUpperCase());
      if (info.format) parts.push(info.format.toUpperCase());
      if (info.captureDate) parts.push(String(info.captureDate).slice(0, 10));
    }
    return parts.join(' · ');
  }

  // Renderable single-image boxes overlay is only meaningful for one stacked
  // image; multi-image cases (change/SAR) just show the pair.
  const isSingleStack = taskType !== 'CHANGE_ANALYSIS' && taskType !== 'OPTICAL_SAR';

  function renderSourceCard(id) {
    const info = tileInfos[id] || null;
    const renderable = !!(info && info.renderable);
    const storedButNotRenderable = !!(info && info.storedFile && !info.renderable);
    const broken = !!(info && info.error);
    const title = sourceCardTitle(info);
    const subtitle = sourceSubtitle(info);

    return (
      <div className="evidence-source-card" key={id}>
        <div className="evidence-source-head">
          <span className="evidence-source-title">{title}</span>
          {subtitle && <span className="evidence-source-subtitle">{subtitle}</span>}
        </div>
        {renderable ? (
          <div className="evidence-viewport">
            <div
              className="evidence-satellite-bg"
              style={{
                backgroundImage: `url(${tileImageUrl(String(info._id))})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              <div className="satellite-grid-overlay" />
              {isSingleStack && showMask && (
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
              {isSingleStack && showBoundingBoxes && boxes.length > 0 && (
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
        ) : (
          <div className="evidence-unavailable">
            {broken
              ? 'Source imagery unavailable.'
              : storedButNotRenderable
                ? 'TIFF source — browser preview unavailable. The raster was analysed but cannot be rendered here.'
                : 'Source imagery was not provided for this analysis.'}
          </div>
        )}

        {isSingleStack && boxes.length > 0 && (
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
      </div>
    );
  }

  // Interactive evidence viewport: T1/T2 Swipe Compare + opacity layers. Used
  // for a pre-result preview (imageUrl) and, once results are in, for any pair
  // of browser-renderable uploaded previews so Swipe/Opacity remain reachable.
  function renderCompareViewport() {
    return (
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
                    {hasTwoImages && (
                      <button className={`layer-toggle-btn ${isCompareMode ? 'active' : ''}`} onClick={() => setIsCompareMode(!isCompareMode)}>
                        <span className="toggle-indicator" />
                        T1 vs T2 Swipe Compare
                      </button>
                    )}
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
                    {isCompareMode && hasTwoImages && (
                      <div className="opacity-slider-item">
                        <span className="slider-label">Swipe Curtain: {swipePos}%</span>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={swipePos}
                          onChange={(e) => setSwipePos(Number(e.target.value))}
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
                        backgroundImage: `url(${isCompareMode && hasTwoImages ? imageT1Url : imageUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }}
                    >
                      {isCompareMode && hasTwoImages && (
                        <div
                          className="evidence-satellite-t2-layer"
                          style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundImage: `url(${imageT2Url})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                            clipPath: `polygon(${swipePos}% 0, 100% 0, 100% 100%, ${swipePos}% 100%)`,
                          }}
                        />
                      )}

                      {isCompareMode && hasTwoImages && (
                        <div
                          className="swipe-curtain-divider"
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: `${swipePos}%`,
                            width: '2px',
                            backgroundColor: '#6eb4ff',
                            boxShadow: '0 0 8px rgba(110, 180, 255, 0.8)',
                            pointerEvents: 'none',
                            zIndex: 10,
                          }}
                        >
                          <div
                            style={{
                              position: 'absolute',
                              top: '50%',
                              left: '50%',
                              transform: 'translate(-50%, -50%)',
                              width: '24px',
                              height: '24px',
                              borderRadius: '50%',
                              backgroundColor: '#3b7ddd',
                              border: '2px solid #ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '10px',
                              color: '#ffffff',
                              fontWeight: 'bold',
                            }}
                          >
                            ↔
                          </div>
                        </div>
                      )}

                      {isCompareMode && hasTwoImages && (
                        <>
                          <div className="absolute top-2 left-2 z-10 px-2 py-1 bg-black/60 rounded text-[10px] text-blue-300 font-semibold uppercase tracking-wider border border-blue-500/30">
                            T1 (Before)
                          </div>
                          <div className="absolute top-2 right-2 z-10 px-2 py-1 bg-black/60 rounded text-[10px] text-cyan-300 font-semibold uppercase tracking-wider border border-cyan-500/30">
                            T2 (After)
                          </div>
                        </>
                      )}

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
    );
  }

  // --- Render ---------------------------------------------------------------

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

      {/* FINDING header — the main answer is never buried */}
      <div className="finding-hero">
        <span className="finding-label">FINDING</span>
        <h2 className="finding-primary">{isAnalyzing ? 'Analyzing satellite imagery…' : findings.primary}</h2>
        {!isAnalyzing && findings.explanation && <p className="finding-explanation">{findings.explanation}</p>}

        <div className="finding-meta">
          <span className={`results-panel-badge ${statusClass}`}>
            <span className="results-panel-badge-dot" />
            {statusLabel}
          </span>
          {confidence && (
            <span className="confidence-chip">
              Overall confidence: <strong>{confidence}</strong>
            </span>
          )}
          {primaryTool && (
            <span className="tool-chip">
              {TOOL_LABELS[primaryTool] || primaryTool}
              {primaryToolConf && <em>· {primaryToolConf}</em>}
            </span>
          )}
          {findings.modelName && (
            <span className="model-chip">
              {findings.modelName}
              {findings.adapterActive !== null && (
                <span className={findings.adapterActive ? 'adapter-active' : 'adapter-inactive'}>
                  LoRA Adapter: {findings.adapterActive ? 'Active' : 'Inactive'}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {isAnalyzing && (
        <div className="analysis-progress">
          <ol className="analysis-stages">
            {analysisStages.map((st) => (
              <li key={st.id} className={`analysis-stage ${st.state}`}>
                <span className="analysis-stage-mark">{st.state === 'done' ? '✓' : st.state === 'active' ? '●' : '○'}</span>
                <span className="analysis-stage-label">{st.label}</span>
              </li>
            ))}
          </ol>
          <p className="analysis-progress-note">
            CPU vision-model inference is in progress — this typically takes 1–2 minutes for one image.
            The request is still running and will complete on its own.
          </p>
          <p className="analysis-progress-elapsed">Elapsed {elapsedLabel}</p>
        </div>
      )}

      {isMock && (
        <div className="result-mock-note">
          <strong>Mock / offline result — live ML inference was unavailable.</strong>{' '}
          The answer and confidence above are labeled substitutes, not measurements.
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="results-tabs">
        <button className={`results-tab ${activeTab === 'evidence' ? 'active' : ''}`} onClick={() => setActiveTab('evidence')}>
          Evidence
        </button>
        <button className={`results-tab ${activeTab === 'answer' ? 'active' : ''}`} onClick={() => setActiveTab('answer')}>
          Findings
        </button>
        <button className={`results-tab ${activeTab === 'quality' ? 'active' : ''}`} onClick={() => setActiveTab('quality')}>
          Data Quality
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
        {/* Tab 1: Evidence */}
        {activeTab === 'evidence' && (
          <div className="results-evidence-view">
            {imageRefs.length > 0 ? (
              <div className="evidence-source-stack">
                <div className={`evidence-source-grid ${imageRefs.length > 1 ? 'multi' : ''}`}>
                  {imageRefs.map((id) => renderSourceCard(id))}
                </div>
                {renderablePair && renderCompareViewport()}
              </div>
            ) : imageUrl ? (
              renderCompareViewport()
            ) : (
              <p className="results-empty-state">
                No source imagery was provided for this analysis.
              </p>
            )}

            <div className="evidence-context-card">
              <span className="intel-card-label">ANALYSIS CONTEXT</span>
              <div className="evidence-context-rows">
                <div className="evidence-context-row">
                  <span className="evidence-context-name">Analysis Scope</span>
                  <span className="evidence-context-val font-semibold text-cyan-300">
                    {resultData?.roiAttachment ? `AOI (${resultData.roiAttachment.name || 'Drawn region'})` : 'Full Scene'}
                  </span>
                </div>
                {taskType === 'VQA' && query && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Question</span>
                    <span className="evidence-context-val">{query}</span>
                  </div>
                )}
                {primaryTool && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Tool used</span>
                    <span className="evidence-context-val">{TOOL_LABELS[primaryTool] || primaryTool}</span>
                  </div>
                )}
                {primaryToolConf && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Tool confidence</span>
                    <span className="evidence-context-val">{primaryToolConf}</span>
                  </div>
                )}
                {inputType && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Input type</span>
                    <span className="evidence-context-val">{inputType}</span>
                  </div>
                )}
                {modalityLabel && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Modality / sensor</span>
                    <span className="evidence-context-val">{modalityLabel}</span>
                  </div>
                )}
                {modelName && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Model</span>
                    <span className="evidence-context-val">{modelName}</span>
                  </div>
                )}
                {findings.adapterActive !== null && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Adapter</span>
                    <span className="evidence-context-val">{findings.adapterActive ? 'Active' : 'Inactive'}</span>
                  </div>
                )}
                {taskType === 'CHANGE_ANALYSIS' && changePct !== null && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Change detected</span>
                    <span className="evidence-context-val">{changePct}%</span>
                  </div>
                )}
                {taskType === 'CHANGE_ANALYSIS' && changeToolResult && isFiniteNumber(changeToolResult.threshold) && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Threshold</span>
                    <span className="evidence-context-val">{changeToolResult.threshold}</span>
                  </div>
                )}
                {taskType === 'CHANGE_ANALYSIS' && changeToolResult && typeof changeToolResult.method === 'string' && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Change method</span>
                    <span className="evidence-context-val">{changeToolResult.method}</span>
                  </div>
                )}
                {findings.isBinary && rawAnswer && (
                  <div className="evidence-context-row">
                    <span className="evidence-context-name">Raw model output</span>
                    <span className="evidence-context-val">{rawAnswer}</span>
                  </div>
                )}
              </div>
            </div>

            {evidence.notes ? (
              <div className="evidence-notes-card">
                <span className="intel-card-label">TOOL DIAGNOSTICS</span>
                <p className="trend-driver-text">{evidence.notes}</p>
              </div>
            ) : null}
            {!evidence.notes && imageRefs.length > 0 && (
              <p className="results-empty-state small">
                No additional supporting evidence was returned by the selected tool.
              </p>
            )}

            {taskType === 'OPTICAL_SAR' && status === 'failed' && /georeferenc/i.test(String(answerText)) && (
              <div className="evidence-notes-card warn">
                <span className="intel-card-label">SAR FUSION REQUIREMENT</span>
                <p className="trend-driver-text">
                  Optical + SAR analysis requires georeferenced optical and SAR rasters. The uploaded images
                  could not be co-registered, so no fusion result was produced.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Findings */}
        {activeTab === 'answer' && (
          <div className="results-findings-view">
            {(boxes.length > 0 || Object.keys(metrics).length > 0 || Object.keys(modelMetadata).length > 0 || severity || vqaFinding || resultData?.roiAttachment) ? (
              <div className="intel-cards-grid">
                {resultData?.roiAttachment && (
                  <div className="p-2.5 rounded bg-cyan-950/40 border border-cyan-500/40 flex items-center justify-between text-xs text-cyan-200">
                    <span className="font-bold flex items-center gap-1.5 uppercase tracking-wider text-[10.5px] text-cyan-300">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                      Analysis Scope: AOI
                    </span>
                    <span className="font-mono text-[10px] text-cyan-200/80">
                      {resultData.roiAttachment.name || 'Drawn bounding box'}
                    </span>
                  </div>
                )}

                {severity && (
                  <div className={`intel-severity-banner severity-${severity.level || 'medium'}`}>
                    <div className="severity-badge">{severity.label || severity.level || 'INFO'}</div>
                    {severity.description && <span className="severity-sub">{severity.description}</span>}
                  </div>
                )}

                {vqaFinding && (
                  <div className="intel-card vqa-finding-card">
                    <span className="intel-card-label">KEY FINDING</span>
                    <div className="vqa-finding-primary">{vqaFinding.primary}</div>
                    {vqaFinding.context && <p className="vqa-finding-context">{vqaFinding.context}</p>}
                    {vqaFinding.question && (
                      <p className="vqa-finding-question">
                        <span className="text-slate-400">Question:</span> "{vqaFinding.question}"
                      </p>
                    )}
                    <div className="vqa-finding-meta">
                      {vqaFinding.tool && <span className="vqa-meta-chip">{vqaFinding.tool} <em>·</em> {vqaFinding.toolConf || 'no tool confidence'}</span>}
                      {vqaFinding.inputType && <span className="vqa-meta-chip">Input: {vqaFinding.inputType}</span>}
                      {vqaFinding.modalityLabel && <span className="vqa-meta-chip">{vqaFinding.modalityLabel}</span>}
                      {vqaFinding.hasAdapterInfo && (
                        <span className={`vqa-meta-chip ${vqaFinding.adapter ? 'adapter-status-ok' : 'adapter-status-warn'}`}>
                          LoRA Adapter: {vqaFinding.adapter ? 'Active' : 'Inactive'}
                        </span>
                      )}
                      {vqaFinding.model && <span className="vqa-meta-chip">Model: {vqaFinding.model}</span>}
                    </div>
                  </div>
                )}
                {/* Interpreted Natural Language Task Plan Card */}
                {(resultData?.interpretedPlan || resultData?.plan) && (
                  <div className="intel-card border-blue-500/40 bg-blue-950/20 p-3 rounded-lg space-y-2">
                    <div className="flex items-center justify-between border-b border-blue-500/30 pb-1.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-blue-300">INTERPRETED QUERY PLAN</span>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-blue-900/60 text-blue-200 border border-blue-700">
                        {resultData?.interpretedPlan?.taskType || taskType}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <span className="text-slate-400 text-[10px] block font-semibold">TASK TYPE:</span>
                        <span className="text-slate-200 font-mono">{resultData?.interpretedPlan?.taskType || taskType}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 text-[10px] block font-semibold">TARGET METRIC:</span>
                        <span className="text-slate-200 font-mono">{resultData?.interpretedPlan?.metric || 'N/A'}</span>
                      </div>
                    </div>

                    <div className="text-[11px] text-slate-300">
                      <span className="font-semibold text-slate-400 block text-[10px]">EXECUTED OPERATIONS:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(resultData?.interpretedPlan?.operations || ['validate', 'fetch', 'execute_tools', 'map']).map((op, i) => (
                          <span key={i} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[9.5px] border border-slate-700">
                            {op}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Candidate Semantic Change Interpretation Card */}
                {(resultData?.toolResults?.find(t => t.tool === 'change')?.result?.candidateInterpretation || (taskType === 'CHANGE_ANALYSIS')) && (
                  <div className="intel-card border-amber-500/40 bg-amber-950/20 p-3 rounded-lg space-y-2">
                    <div className="flex items-center justify-between border-b border-amber-500/30 pb-1.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">CANDIDATE SEMANTIC CHANGE INTERPRETATION</span>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-900/60 text-amber-200 border border-amber-700">
                        {resultData?.toolResults?.find(t => t.tool === 'change')?.result?.candidateInterpretation?.confidenceLabel || 'Moderate Confidence'}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <h4 className="text-xs font-semibold text-amber-200">
                        {resultData?.toolResults?.find(t => t.tool === 'change')?.result?.candidateInterpretation?.candidateTitle || 'Candidate Vegetation / Surface Change'}
                      </h4>

                      <div className="text-[11px] text-slate-300 space-y-1">
                        <span className="font-semibold text-slate-400 block text-[10px]">SUPPORTING EVIDENCE:</span>
                        <ul className="list-disc list-inside space-y-0.5 text-slate-300 font-mono text-[10px]">
                          {(resultData?.toolResults?.find(t => t.tool === 'change')?.result?.candidateInterpretation?.evidence || [
                            `Change mask overlap = ${changeToolResult?.change_percentage || 0}%`,
                            changeToolResult?.changed_area_km2 ? `Changed area = ${changeToolResult.changed_area_km2} km²` : null
                          ].filter(Boolean)).map((ev, i) => (
                            <li key={i}>{ev}</li>
                          ))}
                        </ul>
                      </div>

                      <p className="text-[10px] text-amber-300/80 italic border-t border-amber-500/20 pt-1.5 mt-2">
                        {resultData?.toolResults?.find(t => t.tool === 'change')?.result?.candidateInterpretation?.caveat ||
                          'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'}
                      </p>
                    </div>
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
            ) : (
              <p className="results-empty-state">No additional conclusion metadata was returned for this query.</p>
            )}
          </div>
        )}

        {/* Tab 2.5: Data Quality & Scene Information */}
        {activeTab === 'quality' && (
          <div className="results-quality-view space-y-4 text-xs">
            <div className="p-3 rounded-lg border border-blue-500/20 bg-blue-950/30 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">VALIDATION STATUS</span>
                <span className="text-sm font-semibold text-blue-300">
                  {qualityStatusLabel}
                </span>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase border ${
                qualityStatus === 'CANNOT_ANALYZE'
                  ? 'bg-red-500/20 border-red-500/40 text-red-300'
                  : qualityStatus === 'ANALYSIS_WARNING'
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                    : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
              }`}>
                {qualityStatusLabel}
              </span>
            </div>

            {qualitySummary && (
              <p className="text-slate-300 text-xs italic bg-slate-900/60 p-2.5 rounded border border-white/10">
                "{qualitySummary}"
              </p>
            )}

            <div className="intel-card">
              <span className="intel-card-label">DATA QUALITY CHECKS</span>
              <div className="space-y-2 mt-2">
                {qualityChecks.map((chk, idx) => (
                  <div key={idx} className="flex items-start justify-between p-2 rounded bg-slate-900/40 border border-white/5">
                    <div>
                      <div className="font-semibold text-slate-200">{chk.name}</div>
                      <div className="text-[11px] text-slate-400">{chk.details}</div>
                    </div>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold whitespace-nowrap ${
                      chk.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-300'
                        : chk.status === 'WARN' ? 'bg-amber-500/20 text-amber-300'
                          : chk.status === 'NOT_AVAILABLE' || chk.status === 'LIMITED' ? 'bg-slate-600/30 text-slate-300'
                            : 'bg-red-500/20 text-red-300'
                    }`}>
                      {chk.status === 'NOT_AVAILABLE' ? 'NOT AVAILABLE' : chk.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {resultData?.roiAttachment && (
              <div className="intel-card">
                <span className="intel-card-label">AOI GEOMETRY & SCOPE</span>
                <div className="space-y-1 mt-1 text-slate-300 text-[11px]">
                  <div><strong className="text-slate-400">Label:</strong> {resultData.roiAttachment.name}</div>
                  <div><strong className="text-slate-400">BBox (W, S, E, N):</strong> [{fmtCoord(resultData.roiAttachment.bbox?.west)}, {fmtCoord(resultData.roiAttachment.bbox?.south)}, {fmtCoord(resultData.roiAttachment.bbox?.east)}, {fmtCoord(resultData.roiAttachment.bbox?.north)}]</div>
                </div>
              </div>
            )}

            {sceneEntries.length > 0 && sceneMetadataVisible && (
              <div className="intel-card">
                <span className="intel-card-label">SCENE METADATA (FROM ML VALIDATION)</span>
                <div className="relative overflow-x-auto mt-1">
                  <table className="w-full text-[11px] border-collapse">
                    <thead>
                      <tr className="text-left text-slate-400 border-b border-white/10">
                        <th className="py-1 pr-2 font-semibold">Tile</th>
                        <th className="py-1 pr-2 font-semibold">CRS</th>
                        <th className="py-1 pr-2 font-semibold">Bands</th>
                        <th className="py-1 pr-2 font-semibold">Resolution</th>
                        <th className="py-1 pr-2 font-semibold">Dimensions</th>
                        <th className="py-1 pr-2 font-semibold">Georeferenced</th>
                        <th className="py-1 font-semibold">Valid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sceneEntries.map((sc, i) => (
                        <tr key={i} className="border-b border-white/5 text-slate-300">
                          <td className="py-1 pr-2 whitespace-nowrap text-blue-300">{sc.name}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">{sc.crs || <span className="text-slate-500 italic">Not available</span>}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">{sc.bands ? `${sc.bands} (${sc.bandIds.join('/')})` : <span className="text-slate-500 italic">Not available</span>}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">{sc.resolution ? `${sc.resolution.x} × ${sc.resolution.y} m` : <span className="text-slate-500 italic">Not available</span>}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">{sc.dimensions ? `${sc.dimensions.width} × ${sc.dimensions.height}` : <span className="text-slate-500 italic">Not available</span>}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">
                            {sc.georeferenced ? <span className="text-emerald-300 font-semibold">Yes</span> : <span className="text-slate-500 font-semibold">No</span>}
                          </td>
                          <td className="py-1 whitespace-nowrap">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${sc.valid ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>
                              {sc.valid ? 'VALID' : 'INVALID'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {sceneMetadataVisible === 'raw' && (
                  <p className="text-[10px] text-slate-500 mt-1.5">Full ML validation result available in the exported JSON (rawExecutionTrace & tile metadata).</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Trend */}
        {activeTab === 'trend' && (
          <div className="results-trend-view">
            {!trendState.requested && !trendData ? (
              <div className="trend-not-requested">
                <p className="results-panel-hint">
                  <strong>Trend analysis was not requested for this query.</strong>
                </p>
                <p className="results-panel-hint">
                  Trend analysis is available for region/time-series queries (e.g. NDVI or NDWI over a period).
                </p>
              </div>
            ) : (trendState.data || trendData) ? (
              <div className="trend-analysis-card">
                <span className="finding-label">TREND ANALYSIS</span>
                <div className="trend-meta-grid">
                  {trendState.region && (
                    <div className="trend-meta-item">
                      <span className="trend-meta-name">Region</span>
                      <span className="trend-meta-val">{trendState.region}</span>
                    </div>
                  )}
                  {trendState.metric && (
                    <div className="trend-meta-item">
                      <span className="trend-meta-name">Metric</span>
                      <span className="trend-meta-val">{trendState.metric.toUpperCase()}</span>
                    </div>
                  )}
                  {trendState.period && (
                    <div className="trend-meta-item">
                      <span className="trend-meta-name">Period</span>
                      <span className="trend-meta-val">{trendState.period}</span>
                    </div>
                  )}
                  {trendState.direction && (
                    <div className="trend-meta-item">
                      <span className="trend-meta-name">Trend</span>
                      <span className={`trend-direction ${trendState.direction === 'Increasing' ? 'up' : trendState.direction === 'Decreasing' ? 'down' : 'flat'}`}>
                        {trendState.direction}
                      </span>
                    </div>
                  )}
                </div>

                <TrendChart data={trendState.points || trendData} onInvestigatePeriod={onInvestigatePeriod} />

                {trendState.summary && (
                  <div className="trend-driver-card">
                    <span className="trend-driver-label">SUMMARY</span>
                    <p className="trend-driver-text">{trendState.summary}</p>
                  </div>
                )}
              </div>
            ) : (
              <p className="results-empty-state">
                No trend data was returned for this query.
              </p>
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
                    <div className={`trace-step-marker ${s.failed ? 'failed' : 'ok'}`}>
                      {s.failed ? '!' : '✓'}
                    </div>
                    <div className="trace-step-content">
                      <div className="trace-step-header">
                        <span className="trace-step-number">{s.number}</span>
                        <span className="trace-step-title">{s.title}</span>
                      </div>
                      {s.detail && <div className="trace-step-desc">{s.detail}</div>}
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