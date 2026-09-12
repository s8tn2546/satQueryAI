/**
 * Spectral Profile Analyzer
 * 
 * Provides deterministic spectral band profile extraction for point and region inspection,
 * wavelength metadata mapping, georeferencing validation, and grounded analysis connections.
 */

const SENTINEL2_WAVELENGTHS = {
  B1: { name: 'Coastal aerosol', wavelength: 443 },
  B2: { name: 'Blue', wavelength: 490 },
  B3: { name: 'Green', wavelength: 560 },
  B4: { name: 'Red', wavelength: 665 },
  B5: { name: 'Red Edge 1', wavelength: 705 },
  B6: { name: 'Red Edge 2', wavelength: 740 },
  B7: { name: 'Red Edge 3', wavelength: 783 },
  B8: { name: 'NIR', wavelength: 842 },
  B8A: { name: 'Narrow NIR', wavelength: 865 },
  B9: { name: 'Water vapour', wavelength: 945 },
  B11: { name: 'SWIR 1', wavelength: 1610 },
  B12: { name: 'SWIR 2', wavelength: 2190 }
};

const LANDSAT8_WAVELENGTHS = {
  B1: { name: 'Coastal aerosol', wavelength: 443 },
  B2: { name: 'Blue', wavelength: 482 },
  B3: { name: 'Green', wavelength: 561 },
  B4: { name: 'Red', wavelength: 655 },
  B5: { name: 'NIR', wavelength: 865 },
  B6: { name: 'SWIR 1', wavelength: 1609 },
  B7: { name: 'SWIR 2', wavelength: 2201 }
};

export function extractSpectralProfile({ tile = {}, point = null, mode = 'point', values = {}, regionStats = {} }) {
  const isGeoreferenced = Boolean(tile.crs && tile.crs !== 'undefined' && tile.crs !== 'null');
  const crs = isGeoreferenced ? String(tile.crs) : null;
  const georefStatus = isGeoreferenced
    ? `Georeferenced dataset (${crs})`
    : 'Geospatial point location unavailable because the image is not georeferenced.';

  const coordinates = {
    lat: isGeoreferenced && point && typeof point.lat === 'number' ? point.lat : null,
    lng: isGeoreferenced && point && typeof point.lng === 'number' ? point.lng : null
  };

  const pixelCoordinates = point && (typeof point.pixelX === 'number' || typeof point.x === 'number') ? {
    pixelX: point.pixelX ?? point.x ?? null,
    pixelY: point.pixelY ?? point.y ?? null
  } : null;

  const rawBands = Array.isArray(tile.bands) && tile.bands.length > 0
    ? tile.bands
    : (mode === 'point' ? Object.keys(values) : Object.keys(regionStats));

  const sensor = String(tile.sensor || tile.collection || '').toLowerCase();
  const wavelengthMap = sensor.includes('landsat') ? LANDSAT8_WAVELENGTHS : SENTINEL2_WAVELENGTHS;

  const bandProfiles = rawBands.map((bKey) => {
    const bUpper = String(bKey).toUpperCase();
    const meta = wavelengthMap[bUpper] || null;
    const bandName = meta ? meta.name : bKey;
    const wavelength = meta ? meta.wavelength : (tile.wavelengths && tile.wavelengths[bKey] ? tile.wavelengths[bKey] : null);

    if (mode === 'region') {
      const stats = regionStats[bKey] || regionStats[bUpper] || {};
      return {
        band: bKey,
        name: bandName,
        wavelength: wavelength ?? null,
        wavelengthUnit: wavelength ? 'nm' : null,
        mean: typeof stats.mean === 'number' ? stats.mean : null,
        min: typeof stats.min === 'number' ? stats.min : null,
        max: typeof stats.max === 'number' ? stats.max : null,
        stdDev: typeof stats.stdDev === 'number' ? stats.stdDev : null,
        validPixelCount: typeof stats.validPixelCount === 'number' ? stats.validPixelCount : null
      };
    }

    // Point mode
    const val = values[bKey] ?? values[bUpper] ?? null;
    return {
      band: bKey,
      name: bandName,
      wavelength: wavelength ?? null,
      wavelengthUnit: wavelength ? 'nm' : null,
      value: typeof val === 'number' ? val : null
    };
  });

  // Context notes for NDVI / NDWI support
  const analysisContext = [];
  const findBandVal = (bName) => {
    const item = bandProfiles.find(b => b.band.toUpperCase() === bName.toUpperCase() || b.name.toUpperCase() === bName.toUpperCase());
    return item ? (mode === 'region' ? item.mean : item.value) : null;
  };

  const redVal = findBandVal('B4') ?? findBandVal('Red');
  const nirVal = findBandVal('B8') ?? findBandVal('B5') ?? findBandVal('NIR');
  const greenVal = findBandVal('B3') ?? findBandVal('Green');

  if (redVal !== null && nirVal !== null) {
    const ndvi = (nirVal - redVal) / (nirVal + redVal || 1);
    analysisContext.push(`Red/NIR spectral reflectance values support the computed NDVI (derived value: ${ndvi.toFixed(3)}).`);
  }
  if (greenVal !== null && nirVal !== null) {
    const ndwi = (greenVal - nirVal) / (greenVal + nirVal || 1);
    analysisContext.push(`Green/NIR spectral reflectance values support the computed NDWI (derived value: ${ndwi.toFixed(3)}).`);
  }

  return {
    mode,
    georeferenced: isGeoreferenced,
    crs,
    georefStatus,
    coordinates,
    pixelCoordinates,
    bands: bandProfiles,
    analysisContext: analysisContext.join(' ')
  };
}
