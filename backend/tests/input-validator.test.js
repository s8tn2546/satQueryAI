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
      expect(result.warnings).toContain(expect.stringContaining('bounding box metadata is absent'));
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
