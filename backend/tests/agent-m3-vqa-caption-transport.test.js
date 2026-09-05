import { jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// =============================================================================
// Agent M3 — Core A: real multipart transport for the LLM-based tools.
//
// Uses the REAL mlServiceClient against a stubbed global.fetch so we can verify
// exactly what wire payload reaches the ML service for /vqa and /caption. The
// real ML endpoints accept the uploaded image under the multipart field `image`
// (and `question` as a form field for VQA). No DB/app needed here.
// =============================================================================

let tmpDir;
let originalFetch;
let requests = [];
let scripted = {};

function when(pathname, response) {
  scripted[pathname] = response;
}

async function capturedForm(pathname) {
  const req = requests.find(r => r.pathname === pathname);
  return req ? req.body : null;
}

async function fieldInfo(form, field) {
  const entry = form ? await form.get(field) : null;
  if (!entry) return null;
  return { name: entry.name, text: await entry.text() };
}

async function makeTempFile(name, content) {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

const VQA_ML_RESPONSE = {
  tool: 'vqa',
  status: 'success',
  result: { answer: 'water', question: 'Is there water?' },
  evidence: { image: { filename: 'scene.tif' }, question: 'Is there water?' },
  confidence: 0.8,
  metadata: { filename: 'scene.tif' }
};

const CAPTION_ML_RESPONSE = {
  tool: 'caption',
  status: 'success',
  result: { caption: 'A satellite image of a farmland area.' },
  evidence: { image: { filename: 'scene.tif' } },
  confidence: 0.75,
  metadata: { filename: 'scene.tif' }
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-vqa-caption-'));
  originalFetch = global.fetch;
  global.fetch = jest.fn(async (url, opts = {}) => {
    const { pathname } = new URL(url);
    requests.push({ pathname, body: opts.body, headers: opts.headers });
    const response = scripted[pathname];
    if (!response) {
      throw new Error(`No scripted response for ${pathname}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body)
    };
  });
});

afterAll(async () => {
  global.fetch = originalFetch;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  requests = [];
  scripted = {};
});

describe('Agent M3 — /vqa multipart transport', () => {
  it('streams the file under the `image` field and forwards `question` as a form field', async () => {
    when('/vqa', { body: VQA_ML_RESPONSE });
    const filePath = await makeTempFile('vqa-scene.tif', 'VQABYTES');

    const { default: ml } = await import('../src/services/mlServiceClient.js');
    const result = await ml.callMlService('/vqa', {
      image_path: filePath,
      tile_id: 'tid-vqa-1',
      question: 'Is there water?'
    });

    expect(result).toEqual(VQA_ML_RESPONSE);

    const form = await capturedForm('/vqa');
    expect(form).toBeTruthy();

    const image = await fieldInfo(form, 'image');
    expect(image).not.toBeNull();
    expect(image.text).toBe('VQABYTES');
    expect(image.name).toMatch(/\.tif$/);

    expect(await form.get('question')).toBe('Is there water?');

    // Path/ID metadata must never leak as form fields.
    expect(await form.get('image_path')).toBeNull();
    expect(await form.get('tile_id')).toBeNull();
  });

  it('omits the file field when the local file is missing (honest — no fake bytes)', async () => {
    when('/vqa', { body: VQA_ML_RESPONSE });

    const { default: ml } = await import('../src/services/mlServiceClient.js');
    const result = await ml.callMlService('/vqa', {
      image_path: '/no/such/file.tif',
      tile_id: 'tid-missing',
      question: 'Is there water?'
    });

    expect(result.status).toBe('success');
    expect(result).toEqual(VQA_ML_RESPONSE);

    const form = await capturedForm('/vqa');
    expect(await form.get('image')).toBeNull();
    expect(await form.get('question')).toBe('Is there water?');
  });

  it('falls back to a clearly-labeled mock result when the ML service is unreachable', async () => {
    // No scripted response → global.fetch throws → mock fallback.
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    const result = await ml.callMlService('/vqa', {
      image_path: await makeTempFile('vqa-offline.tif', 'VQABYTES'),
      tile_id: 'tid-offline',
      question: 'Is there vegetation?'
    });

    expect(result.status).toBe('success');
    expect(result.metadata.mock).toBe(true);
    expect(typeof result.result.answer).toBe('string');
  });
});

describe('Agent M3 — /caption multipart transport', () => {
  it('streams the file under the `image` field and preserves non-path parameters', async () => {
    when('/caption', { body: CAPTION_ML_RESPONSE });
    const filePath = await makeTempFile('caption-scene.tif', 'CAPTIONBYTES');

    const { default: ml } = await import('../src/services/mlServiceClient.js');
    const result = await ml.callMlService('/caption', {
      image_path: filePath,
      tile_id: 'tid-caption-1',
      max_length: 60
    });

    expect(result).toEqual(CAPTION_ML_RESPONSE);

    const form = await capturedForm('/caption');
    expect(form).toBeTruthy();

    const image = await fieldInfo(form, 'image');
    expect(image).not.toBeNull();
    expect(image.text).toBe('CAPTIONBYTES');
    expect(image.name).toMatch(/\.tif$/);

    expect(await form.get('max_length')).toBe('60');

    // Path/ID metadata must never leak as form fields.
    expect(await form.get('image_path')).toBeNull();
    expect(await form.get('tile_id')).toBeNull();
  });

  it('falls back to a clearly-labeled mock result when the ML service is unreachable', async () => {
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    const result = await ml.callMlService('/caption', {
      image_path: await makeTempFile('caption-offline.tif', 'CAPTIONBYTES'),
      tile_id: 'tid-caption-off'
    });

    expect(result.status).toBe('success');
    expect(result.metadata.mock).toBe(true);
    expect(typeof result.result.caption).toBe('string');
  });
});