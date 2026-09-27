import { validateInputs } from '../src/agents/inputValidator.js';

describe('Input Validator', () => {
  let trace;

  beforeEach(() => {
    trace = [];
  });

  describe('Pair tasks', () => {
    test('accepts valid CHANGE_ANALYSIS pair', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical', boundingBox: {} },
        { format: 'geotiff', modality: 'optical', boundingBox: {} }
      ];
      const result = validateInputs('CHANGE_ANALYSIS', tiles, trace);
      expect(result.valid).toBe(true);
    });

    test('rejects CHANGE_ANALYSIS with single image', () => {
      const tiles = [{ format: 'geotiff', modality: 'optical' }];
      const result = validateInputs('CHANGE_ANALYSIS', tiles, trace);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('requires exactly 2 images');
    });

    test('accepts valid OPTICAL_SAR pair', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical', boundingBox: {} },
        { format: 'geotiff', modality: 'sar', boundingBox: {} }
      ];
      const result = validateInputs('OPTICAL_SAR', tiles, trace);
      expect(result.valid).toBe(true);
    });

    test('rejects OPTICAL_SAR without both modalities', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical' },
        { format: 'geotiff', modality: 'optical' }
      ];
      const result = validateInputs('OPTICAL_SAR', tiles, trace);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('requires one optical image and one SAR image');
    });

    test('warns about missing bounding box in GeoTIFF pair', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical' },
        { format: 'geotiff', modality: 'optical' }
      ];
      const result = validateInputs('CHANGE_ANALYSIS', tiles, trace);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('bounding box metadata is absent')]));
    });

    test('co-registerated pair with overlapping bounds passes', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical', boundingBox: { west: 0, south: 0, east: 1, north: 1 } },
        { format: 'geotiff', modality: 'optical', boundingBox: { west: 0.5, south: 0.5, east: 1.5, north: 1.5 } }
      ];
      const result = validateInputs('CHANGE_ANALYSIS', tiles, trace);
      expect(result.valid).toBe(true);
      expect(result.warnings).not.toEqual(expect.arrayContaining([expect.stringContaining('Spatial bounds')]));
    });

    test('warns when pair bounds do not overlap', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical', boundingBox: { west: 0, south: 0, east: 1, north: 1 } },
        { format: 'geotiff', modality: 'optical', boundingBox: { west: 5, south: 5, east: 6, north: 6 } }
      ];
      const result = validateInputs('CHANGE_ANALYSIS', tiles, trace);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('footprints do not overlap')]));
    });

    test('warns when only one tile carries a bounding box', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical', boundingBox: { west: 0, south: 0, east: 1, north: 1 } },
        { format: 'geotiff', modality: 'optical' }
      ];
      const result = validateInputs('CHANGE_ANALYSIS', tiles, trace);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('bounding box metadata is absent')]));
    });
  });

  describe('Single image tasks', () => {
    test('accepts valid NDVI request', () => {
      const tiles = [{ format: 'geotiff', modality: 'optical' }];
      const result = validateInputs('NDVI', tiles, trace);
      expect(result.valid).toBe(true);
    });

    test('rejects NDVI with no images', () => {
      const result = validateInputs('NDVI', [], trace);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('requires at least 1 image');
    });

    test('rejects optical-only task with SAR image', () => {
      const tiles = [{ format: 'geotiff', modality: 'sar' }];
      const result = validateInputs('NDVI', tiles, trace);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('requires an optical image');
    });

    test('accepts valid VQA request', () => {
      const tiles = [{ format: 'png', modality: 'optical' }];
      const result = validateInputs('VQA', tiles, trace);
      expect(result.valid).toBe(true);
    });

    test('accepts valid CAPTION request', () => {
      const tiles = [{ format: 'jpeg', modality: 'optical' }];
      const result = validateInputs('CAPTION', tiles, trace);
      expect(result.valid).toBe(true);
    });
  });

  describe('Format validation', () => {
    test('accepts all valid formats', () => {
      const formats = ['geotiff', 'tiff', 'png', 'jpeg'];
      formats.forEach(format => {
        const tiles = [{ format, modality: 'optical' }];
        const result = validateInputs('VQA', tiles, []);
        expect(result.valid).toBe(true);
      });
    });

    test('rejects unsupported format', () => {
      const tiles = [{ format: 'bmp', modality: 'optical' }];
      const result = validateInputs('VQA', tiles, trace);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Unsupported image format');
    });

    test('rejects invalid format in pair task', () => {
      const tiles = [
        { format: 'geotiff', modality: 'optical' },
        { format: 'webp', modality: 'optical' }
      ];
      const result = validateInputs('CHANGE_ANALYSIS', tiles, trace);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Unsupported image format');
    });
  });

  describe('Trace generation', () => {
    test('adds trace entry on success', () => {
      const tiles = [{ format: 'geotiff', modality: 'optical' }];
      validateInputs('NDVI', tiles, trace);
      expect(trace.length).toBeGreaterThan(0);
      expect(trace[0].step).toBe('input_validation');
      expect(trace[0].details).toContain('PASS');
    });

    test('adds trace entry on failure', () => {
      validateInputs('NDVI', [], trace);
      expect(trace.length).toBeGreaterThan(0);
      expect(trace[0].step).toBe('input_validation');
      expect(trace[0].details).toContain('FAIL');
    });
  });

  describe('AOI structural validation', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [[[72.0, 18.0], [72.5, 18.0], [72.5, 18.5], [72.0, 18.5], [72.0, 18.0]]]
    };
    const multiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [[[72.0, 18.0], [72.2, 18.0], [72.2, 18.2], [72.0, 18.2], [72.0, 18.0]]],
        [[[73.0, 19.0], [73.2, 19.0], [73.2, 19.2], [73.0, 19.2], [73.0, 19.0]]]
      ]
    };
    const geoTiles = [{ format: 'geotiff', modality: 'optical', crs: 'EPSG:32643' }];

    test('accepts a structurally valid Polygon and reports it', () => {
      const result = validateInputs('NDVI', geoTiles, trace, { aoi: polygon });
      expect(result.valid).toBe(true);
      expect(result.aoi).toEqual({ status: 'PASS', geometryType: 'Polygon', vertexCount: 5 });
      const check = result.qualityReport.checks.find(c => c.name === 'AOI Geometry Structure');
      expect(check.status).toBe('PASS');
      expect(check.details).toContain('ML service');
    });

    test('accepts a MultiPolygon', () => {
      const result = validateInputs('NDVI', geoTiles, trace, { aoi: multiPolygon });
      expect(result.valid).toBe(true);
      expect(result.aoi.geometryType).toBe('MultiPolygon');
      expect(result.aoi.vertexCount).toBe(10);
    });

    test('accepts a JSON-stringified geometry, as the ML form sends it', () => {
      const result = validateInputs('NDVI', geoTiles, trace, { aoi: JSON.stringify(polygon) });
      expect(result.valid).toBe(true);
      expect(result.aoi.status).toBe('PASS');
    });

    test('unwraps a GeoJSON Feature / FeatureCollection', () => {
      const feature = { type: 'Feature', properties: {}, geometry: polygon };
      const collection = { type: 'FeatureCollection', features: [feature] };
      expect(validateInputs('NDVI', geoTiles, trace, { aoi: feature }).valid).toBe(true);
      expect(validateInputs('NDVI', geoTiles, trace, { aoi: collection }).valid).toBe(true);
    });

    test('rejects an unsupported geometry type', () => {
      const result = validateInputs('NDVI', geoTiles, trace, {
        aoi: { type: 'Point', coordinates: [72, 18] }
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not supported');
    });

    test('rejects a ring that is not closed enough to be an area', () => {
      const result = validateInputs('NDVI', geoTiles, trace, {
        aoi: { type: 'Polygon', coordinates: [[[72, 18], [72.5, 18], [72, 18]]] }
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('at least 4');
    });

    test('rejects non-numeric coordinates', () => {
      const result = validateInputs('NDVI', geoTiles, trace, {
        aoi: { type: 'Polygon', coordinates: [[['72', 18], [72.5, 18], [72.5, 18.5], ['72', 18.5], ['72', 18]]] }
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('finite');
    });

    test('rejects non-finite coordinates instead of letting NaN through', () => {
      const result = validateInputs('NDVI', geoTiles, trace, {
        aoi: { type: 'Polygon', coordinates: [[[72, 18], [null, 18], [72.5, 18.5], [72, 18.5], [72, 18]]] }
      });
      expect(result.valid).toBe(false);
    });

    test('rejects an unparseable JSON string', () => {
      const result = validateInputs('NDVI', geoTiles, trace, { aoi: '{not json' });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not valid JSON');
    });

    test('rejects a non-object AOI', () => {
      const result = validateInputs('NDVI', geoTiles, trace, { aoi: [1, 2, 3] });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('GeoJSON geometry object');
    });

    test('does NOT reject an AOI that does not overlap the tile footprint', () => {
      // Intersection is the ML service's call: it opens the actual pixels.
      const farAway = {
        type: 'Polygon',
        coordinates: [[[10.0, 10.0], [10.5, 10.0], [10.5, 10.5], [10.0, 10.5], [10.0, 10.0]]]
      };
      const result = validateInputs('NDVI', geoTiles, trace, { aoi: farAway });
      expect(result.valid).toBe(true);
    });

    test('does NOT reject an AOI whose CRS is unknown to the backend', () => {
      const result = validateInputs('NDVI', geoTiles, trace, {
        aoi: polygon,
        aoiCrs: 'EPSG:99999-not-real'
      });
      expect(result.valid).toBe(true);
    });

    test('does NOT reject an AOI on a non-georeferenced image', () => {
      const pngTiles = [{ format: 'png', modality: 'optical' }];
      const result = validateInputs('VQA', pngTiles, trace, { aoi: polygon });
      expect(result.valid).toBe(true);
    });

    test('absent AOI is recorded as unscoped, not as a failure', () => {
      const result = validateInputs('NDVI', geoTiles, trace, {});
      expect(result.valid).toBe(true);
      expect(result.aoi).toEqual({ status: 'NONE' });
      expect(result.qualityReport.checks.find(c => c.name === 'AOI Geometry Structure')).toBeUndefined();
    });

    test('empty-string AOI is treated as absent', () => {
      const result = validateInputs('NDVI', geoTiles, trace, { aoi: '' });
      expect(result.valid).toBe(true);
      expect(result.aoi.status).toBe('NONE');
    });

    test('rejects an absurdly complex AOI', () => {
      const ring = [];
      for (let i = 0; i < 11000; i++) ring.push([72 + i * 1e-5, 18 + i * 1e-5]);
      ring.push(ring[0]);
      const result = validateInputs('NDVI', geoTiles, trace, {
        aoi: { type: 'Polygon', coordinates: [ring] }
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('too complex');
    });
  });

  describe('AOI trace entries', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [[[72.0, 18.0], [72.5, 18.0], [72.5, 18.5], [72.0, 18.5], [72.0, 18.0]]]
    };

    test('aoi_validation comes after input_validation on success', () => {
      const tiles = [{ format: 'geotiff', modality: 'optical' }];
      validateInputs('NDVI', tiles, trace, { aoi: polygon });
      const steps = trace.map(t => t.step);
      expect(steps).toContain('input_validation');
      expect(steps).toContain('aoi_validation');
      expect(steps.indexOf('aoi_validation')).toBeGreaterThan(steps.indexOf('input_validation'));
      const aoiEntry = trace.find(t => t.step === 'aoi_validation');
      expect(aoiEntry.details).toContain('PASS');
    });

    test('unscoped runs are labeled SKIP', () => {
      const tiles = [{ format: 'geotiff', modality: 'optical' }];
      validateInputs('NDVI', tiles, trace, {});
      const aoiEntry = trace.find(t => t.step === 'aoi_validation');
      expect(aoiEntry.details).toContain('SKIP');
      expect(aoiEntry.details).toContain('unscoped');
    });

    test('an invalid AOI records FAIL on both steps', () => {
      const tiles = [{ format: 'geotiff', modality: 'optical' }];
      validateInputs('NDVI', tiles, trace, { aoi: { type: 'Point', coordinates: [1, 2] } });
      const aoiEntry = trace.find(t => t.step === 'aoi_validation');
      expect(aoiEntry.details).toContain('FAIL');
    });
  });

  describe('Edge cases', () => {
    test('handles missing modality gracefully', () => {
      const tiles = [{ format: 'geotiff' }];
      const result = validateInputs('VQA', tiles, trace);
      expect(result.valid).toBe(true);
    });

    test('handles AREA task correctly', () => {
      const tiles = [{ format: 'geotiff', modality: 'optical' }];
      const result = validateInputs('AREA', tiles, trace);
      expect(result.valid).toBe(true);
    });

    test('handles GROUNDING task correctly', () => {
      const tiles = [{ format: 'png', modality: 'optical' }];
      const result = validateInputs('GROUNDING', tiles, trace);
      expect(result.valid).toBe(true);
    });
  });
});
