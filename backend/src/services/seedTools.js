import ToolRegistry from '../models/ToolRegistry.js';

export const INITIAL_TOOLS = [
  {
    name: 'vqa',
    description: 'Answer questions about objects, land cover, or attributes in satellite imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { question: 'string', region: 'optional' },
    endpoint: '/vqa',
    outputSchema: { answer: 'string', question: 'string', answer_mode: 'string', confidence: 'float' }
  },
  {
    name: 'caption',
    description: 'Generate detailed natural language caption and description of satellite imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { max_length: 'optional' },
    endpoint: '/caption',
    outputSchema: { caption: 'string', confidence: 'float' }
  },
  {
    name: 'ground',
    description: 'Locate, highlight, and ground specific features or targets in satellite imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { target: 'string' },
    endpoint: '/ground',
    outputSchema: { boundingBox: 'array', label: 'string', detectedFeatures: 'integer' }
  },
  {
    name: 'change',
    description: 'Perform bi-temporal change detection and analysis between image pairs',
    requiredInputs: ['image_t1', 'image_t2'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { metric: 'optional' },
    endpoint: '/change',
    outputSchema: { change_percentage: 'float', mean_difference: 'float', max_difference: 'float', changed_area_km2: 'float', changed_pixels: 'integer', unchanged_pixels: 'integer', threshold: 'float', aligned: 'boolean' }
  },
  {
    name: 'optical_sar',
    description: 'Cross-modal optical and SAR pair fusion and multi-sensor analysis',
    requiredInputs: ['optical_image', 'sar_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { fusionMethod: 'optional' },
    endpoint: '/optical-sar',
    outputSchema: { optical: 'object', sar: 'object', fusion: 'object', overlap: 'object', alignment: 'object', crs: 'object', resolution: 'float' }
  },
  {
    name: 'ndvi',
    description: 'Calculate Normalized Difference Vegetation Index from multispectral imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical'],
    parameters: { region: 'optional' },
    endpoint: '/ndvi',
    outputSchema: { index: 'string', min: 'float', max: 'float', mean: 'float', median: 'float', valid_pixel_count: 'integer', total_pixel_count: 'integer', bands: 'object' }
  },
  {
    name: 'ndwi',
    description: 'Calculate Normalized Difference Water Index from multispectral imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical'],
    parameters: { region: 'optional' },
    endpoint: '/ndwi',
    outputSchema: { index: 'string', min: 'float', max: 'float', mean: 'float', median: 'float', valid_pixel_count: 'integer', total_pixel_count: 'integer', bands: 'object' }
  },
  {
    name: 'area',
    description: 'Calculate geospatial surface area measurements for identified features or masks',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { featureType: 'string' },
    endpoint: '/area',
    outputSchema: { area_km2: 'float', area_ha: 'float', area_m2: 'float', valid_pixel_count: 'integer', total_pixel_count: 'integer', crs: 'string', feature_type: 'string', pixel_area_m2: 'float' }
  },
  {
    name: 'trend',
    description: 'Analyze historical geospatial time-series trends over a specified region',
    requiredInputs: [],
    acceptedModalities: ['optical', 'sar'],
    parameters: { region: 'geojson', metric: 'string', startDate: 'date', endDate: 'date' },
    endpoint: '/trend',
    outputSchema: { series: 'array', trend: 'object', metric: 'string', interval: 'string' }
  },
  {
    name: 'validate',
    description: 'Validate an uploaded image/raster and extract structured metadata (used during upload)',
    requiredInputs: ['image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { modality_hint: 'string' },
    endpoint: '/validate',
    outputSchema: { valid: 'boolean', validation_status: 'string', modality: 'string', width: 'integer', height: 'integer', band_count: 'integer', bands: 'array', crs: 'string', errors: 'array', warnings: 'array' }
  },
  {
    name: 'fetch-imagery',
    description: 'Acquire a co-registered optical + SAR pair for a region via Google Earth Engine (stretch)',
    requiredInputs: ['bounding_box'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { bounding_box: 'geojson', start_date: 'date', end_date: 'date' },
    endpoint: '/fetch-imagery',
    outputSchema: { images: 'array', source: 'string', bounding_box: 'object', date_range: 'object', date_gap_days: 'integer', warnings: 'array' }
  }
];

export const seedTools = async () => {
  try {
    for (const tool of INITIAL_TOOLS) {
      await ToolRegistry.findOneAndUpdate(
        { name: tool.name },
        tool,
        { upsert: true, new: true }
      );
    }
    console.log(`[Seed] Tool registry seeded successfully (${INITIAL_TOOLS.length} tools).`);
  } catch (error) {
    console.error('[Seed] Error seeding tool registry:', error.message);
  }
};
