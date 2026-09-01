import mlServiceClient from '../services/mlServiceClient.js';
import { makeTraceEntry } from '../utils/responseBuilder.js';

function buildPayload(tool, tiles, parameters) {
  const opticalTile = tiles.find(t => t.modality === 'optical') || tiles[0];
  const sarTile = tiles.find(t => t.modality === 'sar');

  const payload = { ...parameters };

  switch (tool.name) {
    case 'vqa':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      payload.question = parameters.question || '';
      break;
    case 'caption':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      break;
    case 'ground':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      payload.target = parameters.target || '';
      break;
    case 'change': {
      const sortedByDate = [...tiles].sort((a, b) => {
        if (a.captureDate && b.captureDate) return new Date(a.captureDate) - new Date(b.captureDate);
        return 0;
      });
      payload.image_t1_path = sortedByDate[0]?.filePath;
      payload.image_t2_path = sortedByDate[1]?.filePath;
      payload.tile_id_t1 = String(sortedByDate[0]?._id);
      payload.tile_id_t2 = String(sortedByDate[1]?._id);
      break;
    }
    case 'optical_sar':
      payload.optical_path = opticalTile?.filePath;
      payload.sar_path = sarTile?.filePath;
      payload.optical_tile_id = String(opticalTile?._id);
      payload.sar_tile_id = String(sarTile?._id);
      break;
    case 'ndvi':
    case 'ndwi':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      break;
    case 'area':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      payload.feature_type = parameters.featureType || '';
      break;
    case 'trend':
      payload.region = parameters.region || {};
      payload.metric = parameters.metric || 'ndvi';
      payload.start_date = parameters.startDate || '';
      payload.end_date = parameters.endDate || '';
      break;
    default:
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
  }

  return payload;
}

export async function executeTools(tools, tiles, parameters, trace) {
  const results = [];

  for (const tool of tools) {
    const payload = buildPayload(tool, tiles, parameters);
    trace.push(makeTraceEntry('tool_execution_start', `Calling tool "${tool.name}" at ${tool.endpoint}`));

    let mlResult;
    try {
      mlResult = await mlServiceClient.callMlService(tool.endpoint, payload);
    } catch (err) {
      const reason = `ML service call threw an error for tool "${tool.name}": ${err.message}`;
      trace.push(makeTraceEntry('tool_execution_failed', reason));
      results.push({ tool: tool.name, status: 'failed', result: {}, error: reason, confidence: 0 });
      continue;
    }

    if (!mlResult || ['error', 'failed', 'failure'].includes(mlResult.status)) {
      // Normalize any ML failure signal (contract status "failed", legacy
      // "failure", or transport-level "error") into a single backend status.
      // Preserve the specific reason (result.error) so the final failure
      // response is honest, not "unknown error".
      const reason = mlResult?.error
        || mlResult?.result?.error
        || `ML service returned an error for tool "${tool.name}"`;
      trace.push(makeTraceEntry('tool_execution_failed', reason));
      results.push({ tool: tool.name, status: 'failed', result: {}, error: reason, confidence: 0 });
    } else if (!mlResult.result && !mlResult.answer && !mlResult.caption && !mlResult.series) {
      const reason = `ML service returned an empty or malformed result for tool "${tool.name}"`;
      trace.push(makeTraceEntry('tool_execution_failed', reason));
      results.push({ tool: tool.name, status: 'failed', result: {}, error: reason, confidence: 0 });
    } else {
      trace.push(makeTraceEntry('tool_execution_success', `Tool "${tool.name}" completed successfully`));
      results.push({ tool: tool.name, status: 'success', ...mlResult });
    }
  }

  return results;
}
