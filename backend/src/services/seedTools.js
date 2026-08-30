import ToolRegistry from '../models/ToolRegistry.js';

export const INITIAL_TOOLS = [
  {
    name: 'vqa',
    description: 'Answer questions about objects, land cover, or attributes in satellite imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { question: 'string', region: 'optional' },
    endpoint: '/vqa',
    outputSchema: { answer: 'string', confidence: 'float' }
  },
  {
    name: 'caption',
    description: 'Generate detailed natural language caption and description of satellite imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { max_length: 'optional' },
    endpoint: '/caption',
    outputSchema: { caption: 'string', keywords: 'array' }
  },
  {
    name: 'ground',
    description: 'Locate, highlight, and ground specific features or targets in satellite imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { target: 'string' },
    endpoint: '/ground',
    outputSchema: { boundingBox: 'array', label: 'string' }
  },
  {
    name: 'change',
    description: 'Perform bi-temporal change detection and analysis between image pairs',
    requiredInputs: ['image_t1', 'image_t2'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { metric: 'optional' },
    endpoint: '/change',
    outputSchema: { changeMaskUrl: 'string', changePercentage: 'float', summary: 'string' }
  },
  {
    name: 'optical_sar',
    description: 'Cross-modal optical and SAR pair fusion and multi-sensor analysis',
    requiredInputs: ['optical_image', 'sar_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { fusionMethod: 'optional' },
    endpoint: '/optical-sar',
    outputSchema: { fusedLandCover: 'object', confidence: 'float' }
  },
  {
    name: 'ndvi',
    description: 'Calculate Normalized Difference Vegetation Index from multispectral imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical'],
    parameters: { region: 'optional' },
    endpoint: '/ndvi',
    outputSchema: { value: 'float', map: 'raster' }
  },
  {
    name: 'ndwi',
    description: 'Calculate Normalized Difference Water Index from multispectral imagery',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical'],
    parameters: { region: 'optional' },
    endpoint: '/ndwi',
    outputSchema: { value: 'float', map: 'raster' }
  },
  {
    name: 'area',
    description: 'Calculate geospatial surface area measurements for identified features or masks',
    requiredInputs: ['optical_image'],
    acceptedModalities: ['optical', 'sar'],
    parameters: { featureType: 'string' },
    endpoint: '/area',
    outputSchema: { areaKm2: 'float', featureType: 'string' }
  },
  {
    name: 'trend',
    description: 'Analyze historical geospatial time-series trends over a specified region',
    requiredInputs: [],
    acceptedModalities: ['optical', 'sar'],
    parameters: { region: 'geojson', metric: 'string', startDate: 'date', endDate: 'date' },
    endpoint: '/trend',
    outputSchema: { series: 'array', trendSlope: 'float' }
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
    console.log('[Seed] Tool registry seeded successfully (9 tools).');
  } catch (error) {
    console.error('[Seed] Error seeding tool registry:', error.message);
  }
};
