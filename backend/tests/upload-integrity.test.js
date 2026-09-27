/**
 * Upload integrity contract.
 *
 * The ML service is the authority on whether a file is a usable raster. The
 * backend must not override it, must never default to "validated" when the
 * verdict is unknown, and must reject files it can positively prove are not
 * rasters. Georeference state and integrity must be persisted so downstream
 * analysis can tell a verified analysis-ready image from an unverified or
 * non-georeferenced one.
 */

import { jest } from '@jest/globals';

const mockCallMlService = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { default: Tile } = await import('../src/models/Tile.js');
const { seedTools } = await import('../src/services/seedTools.js');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedTools();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  mockCallMlService.mockReset();
  await mongoose.connection.collection('tiles').deleteMany({});
});

// A real, decodable 1x1 PNG.
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// A PNG signature followed by garbage: passes a magic-byte check, fails to decode.
const CORRUPT_PNG = Buffer.concat([VALID_PNG.subarray(0, 8), Buffer.alloc(64, 0xde)]);
// A valid PNG signature followed immediately by end-of-file: a truncated image.
const TRUNCATED_PNG = VALID_PNG.subarray(0, 20);

function mlVerdict(result, extra = {}) {
  return {
    tool: 'validate',
    status: 'success',
    confidence: 1,
    result: { valid: true, validation_status: 'valid', errors: [], warnings: [], ...extra },
    evidence: { filename: 'test.tif' }
  };
}

async function upload(buffer, filename = 'test.tif', fields = {}) {
  let req = request(app).post('/api/images/upload');
  req = req.field('modality', 'optical');
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('images', buffer, filename);
}

describe('upload — ML verdict is authoritative', () => {
  it('stores a valid verdict and the analysis-ready integrity category', async () => {
    mockCallMlService.mockResolvedValue(
      mlVerdict({}, { is_georeferenced: true, integrity: 'georeferenced_analysis_ready' })
    );

    const res = await upload(VALID_PNG, 'test.png');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    const tile = await Tile.findById(res.body.tileId);
    expect(tile.validated).toBe(true);
    expect(tile.validationDetails.validationSource).toBe('ml-service');
    expect(tile.integrity).toBe('georeferenced_analysis_ready');
    expect(tile.isGeoreferenced).toBe(true);
  });

  it('rejects the upload when ML reports the file is invalid', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'validate',
      status: 'success',
      confidence: 1,
      result: {
        valid: false,
        validation_status: 'invalid',
        errors: ['Not a readable raster: truncated IFD.'],
        warnings: [],
        is_georeferenced: null,
        integrity: 'invalid'
      }
    });

    const res = await upload(CORRUPT_PNG, 'corrupt.png');

    // A corrupt file must not enter the pipeline.
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('rejected');
    expect(JSON.stringify(res.body)).toMatch(/truncated IFD/i);
    // And no tile may be created for it.
    expect(await Tile.countDocuments({})).toBe(0);
  });

  it('does not treat a non-georeferenced image as invalid', async () => {
    mockCallMlService.mockResolvedValue(
      mlVerdict({}, { is_georeferenced: false, integrity: 'visual_only_valid' })
    );

    const res = await upload(VALID_PNG, 'plain.png');
    expect(res.status).toBe(200);

    const tile = await Tile.findById(res.body.tileId);
    // Still a valid upload, but explicitly not analysis-ready.
    expect(tile.validated).toBe(true);
    expect(tile.isGeoreferenced).toBe(false);
    expect(tile.integrity).toBe('visual_only_valid');
  });

  it('does not invent a georeference verdict the ML service never gave', async () => {
    // A verdict that says nothing about georeferencing.
    mockCallMlService.mockResolvedValue(mlVerdict({}));

    const res = await upload(VALID_PNG, 'test.png');
    const tile = await Tile.findById(res.body.tileId);

    // Unknown must stay unknown, never defaulted to true or false.
    expect(tile.isGeoreferenced).toBeNull();
    expect(tile.integrity).toBeNull();
  });
});

describe('upload — local fallback when ML cannot answer', () => {
  it('accepts a real raster and records that it was not decoded', async () => {
    mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await upload(VALID_PNG, 'test.png');
    expect(res.status).toBe(200);

    const tile = await Tile.findById(res.body.tileId);
    expect(tile.validationDetails.validationSource).toBe('local-fallback');
    // Only the container was checked, so this must not read as verified.
    expect(tile.validationDetails.unverifiedReason).toMatch(/not decoded/i);
    expect(tile.integrity).toBe('unverified');
    expect(tile.isGeoreferenced).toBeNull();
  });

  it('rejects content that is not a raster container at all', async () => {
    mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await upload(Buffer.from('this is definitely not an image'), 'test.png');

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('rejected');
    expect(await Tile.countDocuments({})).toBe(0);
  });

  it('rejects an empty file', async () => {
    mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await upload(Buffer.alloc(0), 'test.png');
    expect(res.status).toBe(400);
    expect(await Tile.countDocuments({})).toBe(0);
  });
});

describe('upload — no optimistic defaults', () => {
  it('never marks a tile validated when the ML service returns no verdict', async () => {
    // A mock/offline response with no `valid` field must not be read as valid.
    mockCallMlService.mockResolvedValue({
      tool: 'validate',
      status: 'failed',
      confidence: 0,
      result: {},
      metadata: { mock: true, offline: true, available: false }
    });

    const res = await upload(VALID_PNG, 'test.png');

    if (res.status === 200) {
      const tile = await Tile.findById(res.body.tileId);
      // Whatever happened, the source must be disclosed, not 'ml-service'.
      expect(tile.validationDetails.validationSource).not.toBe('ml-service');
    } else {
      expect(res.body.status).toBe('rejected');
    }
    expect(await Tile.countDocuments({ validated: true, 'validationDetails.validationSource': 'ml-service' })).toBe(0);
  });
});
