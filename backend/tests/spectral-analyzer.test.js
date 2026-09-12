import { extractSpectralProfile } from '../src/utils/spectralAnalyzer.js';

describe('Spectral Profile Analyzer', () => {
  test('handles georeferenced multispectral point inspection with wavelengths', () => {
    const tile = {
      _id: 'tile_s2_01',
      crs: 'EPSG:4326',
      bands: ['B2', 'B3', 'B4', 'B8'],
      sensor: 'Sentinel-2'
    };
    const point = { lat: 37.7749, lng: -122.4194 };
    const rawValues = { B2: 0.08, B3: 0.12, B4: 0.06, B8: 0.48 };

    const profile = extractSpectralProfile({ tile, point, mode: 'point', values: rawValues });

    expect(profile.georeferenced).toBe(true);
    expect(profile.crs).toBe('EPSG:4326');
    expect(profile.coordinates.lat).toBe(37.7749);
    expect(profile.coordinates.lng).toBe(-122.4194);
    expect(profile.bands).toHaveLength(4);
    expect(profile.bands[0].band).toBe('B2');
    expect(profile.bands[0].name).toBe('Blue');
    expect(profile.bands[0].wavelength).toBe(490);
    expect(profile.bands[0].value).toBe(0.08);
    expect(profile.bands[3].band).toBe('B8');
    expect(profile.bands[3].value).toBe(0.48);
    expect(profile.analysisContext).toContain('Red/NIR spectral reflectance values support the computed NDVI');
  });

  test('handles unreferenced PNG/JPEG cleanly without inventing coordinates', () => {
    const tile = {
      _id: 'tile_png_01',
      format: 'png',
      crs: null,
      bands: ['R', 'G', 'B']
    };
    const point = { pixelX: 120, pixelY: 240 };
    const rawValues = { R: 180, G: 200, B: 150 };

    const profile = extractSpectralProfile({ tile, point, mode: 'point', values: rawValues });

    expect(profile.georeferenced).toBe(false);
    expect(profile.georefStatus).toBe('Geospatial point location unavailable because the image is not georeferenced.');
    expect(profile.coordinates.lat).toBeNull();
    expect(profile.coordinates.lng).toBeNull();
    expect(profile.pixelCoordinates).toEqual({ pixelX: 120, pixelY: 240 });
  });

  test('does NOT invent wavelengths when band metadata lacks wavelength info', () => {
    const tile = {
      _id: 'tile_custom_01',
      crs: 'EPSG:32633',
      bands: ['Band_A', 'Band_B', 'Band_C']
    };
    const rawValues = { Band_A: 12, Band_B: 45, Band_C: 88 };

    const profile = extractSpectralProfile({ tile, mode: 'point', values: rawValues });

    expect(profile.bands[0].wavelength).toBeNull();
    expect(profile.bands[0].band).toBe('Band_A');
    expect(profile.bands[1].wavelength).toBeNull();
  });

  test('calculates region statistics for multispectral band profile', () => {
    const tile = {
      _id: 'tile_s2_reg',
      crs: 'EPSG:4326',
      bands: ['B3', 'B8'],
      sensor: 'Sentinel-2'
    };
    const regionStats = {
      B3: { mean: 0.14, min: 0.10, max: 0.18, stdDev: 0.02, validPixelCount: 500 },
      B8: { mean: 0.52, min: 0.45, max: 0.60, stdDev: 0.04, validPixelCount: 500 }
    };

    const profile = extractSpectralProfile({ tile, mode: 'region', regionStats });

    expect(profile.mode).toBe('region');
    expect(profile.bands[1].band).toBe('B8');
    expect(profile.bands[1].name).toBe('NIR');
    expect(profile.bands[1].wavelength).toBe(842);
    expect(profile.bands[1].mean).toBe(0.52);
    expect(profile.bands[1].validPixelCount).toBe(500);
    expect(profile.analysisContext).toContain('Green/NIR spectral reflectance values support the computed NDWI');
  });
});
