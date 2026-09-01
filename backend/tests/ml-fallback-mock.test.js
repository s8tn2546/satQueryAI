import { jest } from '@jest/globals';

const { default: mlServiceClient } = await import('../src/services/mlServiceClient.js');

let originalFetch;

beforeAll(() => {
  originalFetch = global.fetch;
  // Force the mock fallback path deterministically: any HTTP response that is
  // non-ok makes callMlService return getMockResult(...). This avoids depending on
  // whether a real ML service is running on localhost:8000.
  global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => 'offline' }));
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('ML mock-fallback evidence key alignment (Member 6 Geo integration)', () => {
  it('returns evidence.images from tile_id for /ndvi', async () => {
    const r = await mlServiceClient.callMlService('/ndvi', { tile_id: 'abc123' });
    expect(r.status).toBe('success');
    expect(r.evidence.images).toEqual(['abc123']);
  });

  it('returns evidence.images from tile_id for /ndwi', async () => {
    const r = await mlServiceClient.callMlService('/ndwi', { tile_id: 'abc123' });
    expect(r.status).toBe('success');
    expect(r.evidence.images).toEqual(['abc123']);
  });

  it('returns evidence.images from tile_id for /area', async () => {
    const r = await mlServiceClient.callMlService('/area', { tile_id: 'abc123' });
    expect(r.status).toBe('success');
    expect(r.evidence.images).toEqual(['abc123']);
  });

  it('returns evidence.images from tile_id_t1/tile_id_t2 for /change', async () => {
    const r = await mlServiceClient.callMlService('/change', { tile_id_t1: 't1', tile_id_t2: 't2' });
    expect(r.status).toBe('success');
    expect(r.evidence.images).toEqual(['t1', 't2']);
  });

  it('returns evidence.images from optical_tile_id/sar_tile_id for /optical-sar', async () => {
    const r = await mlServiceClient.callMlService('/optical-sar', { optical_tile_id: 'o1', sar_tile_id: 's1' });
    expect(r.status).toBe('success');
    expect(r.evidence.images).toEqual(['o1', 's1']);
  });
});
