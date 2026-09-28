import fs from 'fs';

/**
 * Public view of a tile for the UI/API. Never exposes server-internal on-disk
 * paths (filePath/analysisRaster/previews.png are server-internal) — only
 * existence booleans (storedFile / hasPreview) convey whether bytes are present.
 * Path-like keys in metadata are scrubbed for the same reason.
 */

const BROWSER_RENDERABLE = new Set(['png', 'jpeg']);

const INTERNAL_METADATA_KEYS = new Set(['filePath', 'image_path', 'analysisRaster']);

function fileExists(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p !== 'mock-no-file' &&
    fs.existsSync(p) &&
    fs.statSync(p).isFile()
  );
}

function safeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (INTERNAL_METADATA_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function publicTile(tile) {
  const previews = (tile.previews && typeof tile.previews === 'object') ? tile.previews : {};
  const previewPng = previews.png;
  const hasPreview = fileExists(previewPng);
  const storedFile = fileExists(tile.filePath);
  return {
    _id: tile._id,
    source: tile.source,
    modality: tile.modality,
    format: tile.format,
    captureDate: tile.captureDate,
    crs: tile.crs,
    resolution: tile.resolution,
    bands: tile.bands || [],
    validated: tile.validated,
    boundingBox: tile.boundingBox || null,
    validationDetails: tile.validationDetails || {},
    provider: tile.provider || null,
    sceneId: tile.sceneId || null,
    collection: tile.collection || null,
    dedupeKey: tile.dedupeKey || null,
    previews: {
      png: hasPreview,
      channels: previews.channels || null,
      stretch: previews.stretch || null
    },
    metadata: safeMetadata(tile.metadata || {}),
    storedFile,
    hasPreview,
    renderable: (storedFile && BROWSER_RENDERABLE.has(tile.format)) || hasPreview
  };
}

export default publicTile;