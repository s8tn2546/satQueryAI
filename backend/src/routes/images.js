import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Tile from '../models/Tile.js';
import mlServiceClient from '../services/mlServiceClient.js';
import { publicTile } from '../utils/publicTile.js';

const router = express.Router();

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/**
 * Stored filename is built ONLY from server-generated data (a timestamp + a
 * derived, allowlisted extension) — never from client-supplied characters, so
 * arbitrary uploads cannot influence the on-disk path or traverse directories.
 */
const SAFE_EXT_RE = /^[a-z0-9]{1,6}$/;

function safeStoredExt(originalExt) {
  const ext = String(originalExt || '').toLowerCase().replace('.', '');
  return SAFE_EXT_RE.test(ext) ? ext : 'bin';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${file.fieldname}-${uniqueSuffix}.${safeStoredExt(path.extname(file.originalname))}`);
  }
});

const MAX_FILE_SIZE = 500 * 1024 * 1024; // align with ML /validate MAX_FILE_SIZE_MB = 500

const ALLOWED_UPLOAD_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/tiff',
  'application/geo+tiff',
  'application/octet-stream'
]);

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 5,
    fields: 10,
    parts: 20
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
      const err = new Error(`Unsupported file type "${ext || '(none)'}". Accepted: .tif, .tiff, .gtiff, .png, .jpg, .jpeg.`);
      err.statusCode = 400;
      return cb(err);
    }
    if (file.mimetype && !ALLOWED_UPLOAD_MIMES.has(String(file.mimetype).toLowerCase())) {
      const err = new Error(`Unsupported content type "${file.mimetype}" for "${file.originalname}".`);
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

const ALLOWED_UPLOAD_EXTS = new Set(['.tif', '.tiff', '.gtiff', '.png', '.jpg', '.jpeg']);
const ALLOWED_SOURCES = new Set(['sentinel-2', 'landsat-8', 'landsat-9', 'bhuvan', 'cartosat-2s', 'risat', 'benchmark-upload', 'gee-fetch']);
const ALLOWED_MODALITIES = new Set(['optical', 'sar']);

function inferFormat(ext) {
  ext = (ext || '').toLowerCase().replace('.', '');
  if (['geotiff', 'gtiff'].includes(ext)) return 'geotiff';
  if (['tiff', 'tif'].includes(ext)) return 'tiff';
  if (['jpg', 'jpeg'].includes(ext)) return 'jpeg';
  return 'png';
}

/**
 * Minimal container-signature check for an already-stored upload.
 *
 * This is a corruption gate, not a raster parser: it reads only the leading
 * magic bytes and answers "is this file plausibly a TIFF/PNG/JPEG at all?".
 * That distinction matters because the extension check above is trivially
 * spoofable — renaming random bytes to `scene.tif` passes it — and because a
 * file that cannot be opened must never reach a scientific tool that would
 * otherwise report a plausible-looking failure or, worse, a mock result.
 *
 * A clean pass is deliberately NOT a validity claim: decoding the pixels is the
 * ML service's job. This only guarantees the file is a real container, so a
 * corrupt upload is rejected at the boundary instead of after analysis.
 */
const RASTER_SIGNATURES = [
  {
    name: 'TIFF',
    bytes: [0x49, 0x49, 0x2a, 0x00], // little-endian: "II*\0"
    alt: [0x4d, 0x4d, 0x00, 0x2a]  // big-endian:    "MM\0*"
  },
  {
    name: 'PNG',
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  },
  {
    name: 'JPEG',
    bytes: [0xff, 0xd8, 0xff]
  }
];

function matchesSignature(head, candidate) {
  if (head.length < candidate.length) return false;
  return candidate.every((byte, i) => head[i] === byte);
}

/**
 * Inspect the first bytes of a stored upload.
 * Returns { ok: true, container } or { ok: false, reason }.
 */
function inspectRasterSignature(filePath) {
  let handle;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      return { ok: false, reason: 'File is empty (0 bytes).' };
    }
    // Read only the header. Max signature length is 8 bytes.
    const head = Buffer.alloc(16);
    const fd = fs.openSync(filePath, 'r');
    handle = fd;
    const bytesRead = fs.readSync(fd, head, 0, 16, 0);
    const slice = head.subarray(0, bytesRead);
    for (const sig of RASTER_SIGNATURES) {
      if (matchesSignature(slice, sig.bytes) || (sig.alt && matchesSignature(slice, sig.alt))) {
        return { ok: true, container: sig.name };
      }
    }
    return {
      ok: false,
      reason:
        'File is not a readable TIFF, PNG or JPEG container. The content does not match ' +
        'any supported raster signature, so it is corrupt or mislabelled.'
    };
  } catch (err) {
    return { ok: false, reason: 'The file could not be read.' };
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already closed */ }
    }
  }
}

/**
 * Normalize a bounding box into the canonical GeoJSON Polygon the Tile schema
 * expects ({ type: 'Polygon', coordinates: [[[lon, lat], ...]] }).
 *
 * Accepts the shapes produced by the current implementation:
 *   - already-canonical GeoJSON Polygon
 *   - compact array [minLon, minLat, maxLon, maxLat]
 *   - bounds object { west, south, east, north } (ML /fetch-imagery shape)
 * Corner coordinates produced by the fetch implementation are preserved; no
 * coordinates are invented. Returns null for anything unrecognized so callers
 * can reject cleanly instead of persisting malformed geometry.
 */
function normalizeBoundingBox(value) {
  if (!value || typeof value !== 'object') return null;

  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const toRing = coords => {
    if (!Array.isArray(coords) || coords.length < 4) return null;
    const ring = coords.filter(p => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]));
    return ring.length >= 4 ? ring : null;
  };

  if (value.type === 'Polygon' && Array.isArray(value.coordinates)) {
    const ring = toRing(value.coordinates[0]);
    if (ring) return { type: 'Polygon', coordinates: [ring] };
    return null;
  }

  if (value.type === 'MultiPolygon' && Array.isArray(value.coordinates)) {
    // Tile schema stores a single polygon; promote the first ring of the
    // first polygon using the coordinates as supplied.
    const ring = toRing(value.coordinates?.[0]?.[0]);
    if (ring) return { type: 'Polygon', coordinates: [ring] };
    return null;
  }

  if (Array.isArray(value) && value.length === 4 && value.every(isNum)) {
    const [minLon, minLat, maxLon, maxLat] = value;
    return {
      type: 'Polygon',
      coordinates: [[
        [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]
      ]]
    };
  }

  const { west, south, east, north } = value;
  if (isNum(west) && isNum(south) && isNum(east) && isNum(north)) {
    return {
      type: 'Polygon',
      coordinates: [[
        [west, south], [east, south], [east, north], [west, north], [west, south]
      ]]
    };
  }

  return null;
}

function cleanupStoredFiles(files) {
  for (const f of files || []) {
    try {
      fs.unlinkSync(f.path);
    } catch {
      // best effort — ignore missing files
    }
  }
}

/**
 * Roll back a partially-processed upload: remove every stored file AND every
 * Tile already persisted for this request. A multi-file upload must be
 * all-or-nothing — a tile pointing at a deleted file is worse than no tile.
 */
async function rollbackUpload(createdTiles, files) {
  cleanupStoredFiles(files);
  for (const t of createdTiles || []) {
    try {
      await Tile.deleteOne({ _id: t._id });
    } catch {
      // best effort
    }
    try {
      if (t.filePath && t.filePath !== 'mock-no-file') fs.unlinkSync(t.filePath);
    } catch {
      // best effort
    }
  }
}

function rejectedUpload(res, error) {
  return res.status(400).json({ status: 'rejected', error });
}

/**
 * Extract a persisted, exposed metadata object from the ML /validate result.
 * Every field is taken verbatim from the ML response (never invented); fields
 * the ML service did not return are omitted so the UI only shows real values.
 */
function extractValidateMetadata(mlResult) {
  const v = (mlResult && mlResult.result) || {};
  const meta = {};
  for (const [key, value] of Object.entries(v)) {
    if (value === null || value === undefined) continue;
    meta[key] = value;
  }
  return meta;
}

/**
 * Derive the smaller backward-compatible tiles fields (crs, resolution,
 * bands) from the full /validate metadata.
 */
function deriveTileFields(v) {
  const bands = Array.isArray(v?.bands)
    ? v.bands
        .map((b) => (b && typeof b === 'object') ? (b.detected_name || b.description || (b.index != null ? String(b.index) : '')) : '')
        .filter(Boolean)
    : [];
  let resolution = null;
  const res = v?.resolution;
  if (res && typeof res === 'object' && Number.isFinite(res.x)) {
    resolution = Number(res.x);
  } else if (Number.isFinite(res)) {
    resolution = Number(res);
  }
  return {
    crs: typeof v?.crs === 'string' ? v.crs : null,
    resolution,
    bands
  };
}

/**
 * Ask the ML service's /validate endpoint for a real validation verdict.
 *
 * Returns { validated, validationDetails, metadata, integrity, isGeoreferenced }.
 *
 * Two verifiers, in strict order of authority:
 *
 *   1. The ML service actually opening the file. It decodes the raster, so its
 *      verdict is authoritative and is used whenever it renders one.
 *   2. A local container-signature check, used only when ML is unavailable or
 *      silent. This is a weaker but real check: it rejects the common case of
 *      corrupt/mislabelled bytes that a lenient extension check would wave
 *      through, so a bad file is still caught while the ML service is down.
 *
 * `validated` is never optimistically true. A previous version defaulted to
 * `true` whenever ML was down, which let a corrupt file upload cleanly and then
 * fail — or be papered over by a mock result — deep inside analysis. When the
 * file was not decoded, `unverifiedReason` records that, so "verified" and
 * "only structurally sound" stay distinguishable downstream.
 */
async function validateWithMlService(file, modalityHint, format) {
  let mlResult;
  try {
    mlResult = await mlServiceClient.callMlService('/validate', {
      image_path: file.path,
      modality_hint: modalityHint,
      format
    });
  } catch (err) {
    console.warn(`[Upload] /validate ML call failed, using local signature check: ${err.message}`);
    mlResult = null;
  }

  const v = (mlResult && mlResult.result) || {};
  const mlVerdict = mlResult
    && mlResult.status !== 'failed'
    && mlResult.status !== 'error'
    && typeof v.valid === 'boolean'
    ? v.valid
    : null;

  if (mlVerdict !== null) {
    // ML decoded the file; its verdict wins outright.
    const metadata = extractValidateMetadata(mlResult);
    return {
      validated: mlVerdict,
      validationDetails: {
        formatValid: v.formatValid ?? true,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        validationStatus: v.validation_status ?? null,
        errors: v.errors ?? [],
        warnings: v.warnings ?? [],
        confidence: mlResult.confidence,
        validationSource: 'ml-service'
      },
      metadata,
      integrity: v.integrity ?? (mlVerdict ? null : 'invalid'),
      isGeoreferenced: typeof v.is_georeferenced === 'boolean' ? v.is_georeferenced : null
    };
  }

  // ML could not render a verdict — fall back to the structural check.
  const signature = inspectRasterSignature(file.path);
  if (!signature.ok) {
    return {
      validated: false,
      validationDetails: {
        formatValid: false,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        errors: [signature.reason],
        warnings: [],
        validationSource: 'local-fallback'
      },
      metadata: {},
      integrity: 'invalid',
      isGeoreferenced: null
    };
  }

  return {
    validated: true,
    validationDetails: {
      formatValid: true,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      container: signature.container,
      errors: [],
      warnings: [],
      unverifiedReason:
        'The ML validation service was unavailable, so the file was not decoded. '
        + 'Only its container signature was verified.',
      validationSource: 'local-fallback'
    },
    metadata: {},
    integrity: 'unverified',
    isGeoreferenced: null
  };
}

router.post('/upload', (req, res) => {
  upload.array('images', 5)(req, res, async (uploadErr) => {
    if (uploadErr) {
      cleanupStoredFiles(req.files);
      if (uploadErr instanceof multer.MulterError) {
        if (uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            status: 'rejected',
            error: `File too large. Maximum file size is ${MAX_FILE_SIZE / (1024 * 1024)} MB.`
          });
        }
        return rejectedUpload(res, `Upload rejected: ${uploadErr.message}`);
      }
      return rejectedUpload(res, `Upload rejected: ${uploadErr.message}`);
    }

    const tileIds = [];
    const tiles = [];

    try {
      const files = req.files || [];

      if (files.length === 0) {
        return rejectedUpload(res, 'No image files provided for upload.');
      }

      const { source, modality } = req.body;

      if (source && !ALLOWED_SOURCES.has(source)) {
        cleanupStoredFiles(files);
        return rejectedUpload(res, `Unsupported source "${source}". Accepted: ${[...ALLOWED_SOURCES].join(', ')}.`);
      }

      const modalityList = Array.isArray(modality) ? modality : [modality];
      const invalidModalities = modalityList.filter(m => m && !ALLOWED_MODALITIES.has(String(m).toLowerCase()));
      if (invalidModalities.length > 0) {
        cleanupStoredFiles(files);
        return rejectedUpload(res, `Unsupported modality "${invalidModalities.join(', ')}". Accepted: optical, sar.`);
      }

      const unsupportedExts = files
        .map(f => path.extname(f.originalname).toLowerCase())
        .filter(ext => !ALLOWED_UPLOAD_EXTS.has(ext));
      if (unsupportedExts.length > 0) {
        cleanupStoredFiles(files);
        return rejectedUpload(res, `Unsupported file type "${unsupportedExts.join(', ')}". Accepted: .tif, .tiff, .gtiff, .png, .jpg, .jpeg.`);
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = path.extname(file.originalname);
        const format = inferFormat(ext);

        let fileModality = 'optical';
        if (Array.isArray(modality)) {
          fileModality = String(modality[i] || 'optical').toLowerCase();
        } else if (modality) {
          fileModality = String(modality).toLowerCase();
        }

        const {
          validated,
          validationDetails,
          metadata,
          integrity,
          isGeoreferenced
        } = await validateWithMlService(
          file,
          req.body.modality_hint || fileModality,
          format
        );

        // A file that could not be opened is category C: it must not become a
        // tile, because every downstream tool assumes an openable raster and
        // would otherwise produce a failure (or a mock) that looks like analysis.
        if (!validated) {
          await rollbackUpload(tiles, files);
          const detail = (validationDetails.errors || []).join(' ') ||
            'The file could not be validated as a readable raster.';
          return res.status(400).json({
            status: 'rejected',
            error: `Upload rejected: ${detail}`,
            file: file.originalname,
            validationDetails
          });
        }

        const derived = deriveTileFields(metadata);
        const boundingBox = normalizeBoundingBox(metadata.wgs84_bounds || metadata.bounds) || null;

        const tile = await Tile.create({
          source: source || 'benchmark-upload',
          modality: fileModality,
          format: format,
          filePath: file.path,
          validated,
          validationDetails,
          ...(boundingBox ? { boundingBox } : {}),
          crs: derived.crs || null,
          resolution: derived.resolution,
          bands: derived.bands,
          // Truthful spatial-readiness state, recorded explicitly so a consumer
          // never has to infer georeferencing from a missing crs/resolution.
          isGeoreferenced: isGeoreferenced ?? null,
          integrity: integrity ?? null,
          metadata
        });

        tileIds.push(tile._id);
        tiles.push(tile);
      }

      return res.status(200).json({
        status: 'success',
        tileId: tileIds[0],
        tileIds: tileIds,
        tiles: tiles.map(publicTile),
        validationResult: {
          valid: tiles.every(t => t.validated),
          count: tiles.length
        }
      });
    } catch (error) {
      await rollbackUpload(tiles, req.files || []);
      console.error('[Upload] Error uploading images:', error);
      return res.status(500).json({
        status: 'failed',
        error: 'An internal error occurred while processing the upload.'
      });
    }
  });
});

/**
 * Region-based image acquisition (STRETCH — BACKEND.md §6.1a).
 * Accepts a GeoJSON bounding box, asks the ML service's /fetch-imagery endpoint
 * for a co-registered optical + SAR pair, stores each returned image as a tiles
 * document with source "gee-fetch", and returns tileId(s) in exactly the same
 * response shape as POST /api/images/upload.
 */
router.post('/fetch-by-region', async (req, res) => {
  try {
    const { boundingBox, startDate, endDate } = req.body || {};

    const canonicalBbox = normalizeBoundingBox(boundingBox);
    if (!canonicalBbox) {
      return res.status(400).json({
        status: 'rejected',
        error: 'boundingBox (GeoJSON) is required for fetch-by-region.'
      });
    }

    const mlResult = await mlServiceClient.callMlService('/fetch-imagery', {
      bounding_box: canonicalBbox,
      start_date: startDate || undefined,
      end_date: endDate || undefined
    });

    if (!mlResult || mlResult.status === 'failed' || mlResult.status === 'error') {
      const reason = mlResult?.result?.error || mlResult?.error || 'Imagery acquisition failed.';
      return res.status(200).json({
        status: 'failed',
        tileId: null,
        tileIds: [],
        tiles: [],
        error: reason,
        validationResult: { valid: false, count: 0 }
      });
    }

    const images = mlResult.result?.images || [];
    const tileIds = [];
    const tiles = [];

    for (const img of images) {
      const filePath = img.filePath || null;
      const format = filePath && /\.(tif|tiff|gtiff)$/i.test(filePath) ? 'geotiff' : 'png';
      // Normalize whatever shape the fetch implementation returned (mock echo,
      // real GEE, or bounds metadata) into the canonical Polygon before
      // persisting; fall back to the canonical request bbox, never raw data.
      const imageBbox = normalizeBoundingBox(img.boundingBox ?? img.bounding_box) || canonicalBbox;

      const tile = await Tile.create({
        source: 'gee-fetch',
        modality: img.modality || 'optical',
        format,
        captureDate: img.captureDate ? new Date(img.captureDate) : null,
        boundingBox: imageBbox,
        crs: img.crs || null,
        resolution: img.resolution ?? null,
        bands: img.bands || [],
        // Tile.filePath is required by schema; mock acquisition yields no real file,
        // so fall back to a clearly-labelled placeholder (never a real host path).
        filePath: filePath || 'mock-no-file',
        validated: Boolean(img.validated),
        validationDetails: {
          validationStatus: img.validation_status ?? null,
          validationWarnings: img.validation_warnings ?? [],
          validationErrors: img.validation_errors ?? [],
          source: 'gee-fetch',
          dataSource: mlResult.result?.source || mlResult.metadata?.data_source || null,
          downloaded: Boolean(img.downloaded),
          geometryFollows: Boolean(imageBbox)
        },
        metadata: {
          modality: img.modality || null,
          source: img.source || null,
          satellite: img.satellite || null,
          captureDate: img.captureDate || null,
          crs: img.crs || null,
          resolution: img.resolution ?? null,
          bands: Array.isArray(img.bands) ? img.bands : [],
          validationStatus: img.validation_status ?? null
        }
      });

      tileIds.push(tile._id);
      tiles.push(tile);
    }

    return res.status(200).json({
      status: 'success',
      tileId: tileIds[0] ?? null,
      tileIds: tileIds,
      tiles: tiles.map(publicTile),
      source: mlResult.result?.source || mlResult.metadata?.data_source || 'unknown',
      dateGapDays: mlResult.result?.date_gap_days ?? null,
      validationResult: {
        valid: tiles.every(t => t.validated),
        count: tiles.length
      }
    });
  } catch (error) {
    console.error('[FetchByRegion] Error acquiring imagery:', error);
    return res.status(500).json({
      status: 'failed',
      error: 'An internal error occurred while acquiring imagery.'
    });
  }
});

export default router;
