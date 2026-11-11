import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking fetch — must come after vi.stubGlobal
import * as api from '../api'; // eslint-disable-line import/first

// Helper to create a mock Response
function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: () => Promise.resolve(data),
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.version', () => {
  it('calls GET /api/version/check', async () => {
    const versionData: api.VersionCheckResponse = {
      current: '0.3.0',
      latest: '0.4.0',
      update_available: true,
      download_url: 'https://example.com',
      release_notes: 'New features',
      asset_url: null,
      checksums_url: null,
    };

    mockFetch.mockResolvedValue(mockResponse(versionData));

    const result = await api.version.check();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/version/check');
    expect(result).toEqual(versionData);
  });
});

describe('nothing about the work is kept by the browser', () => {
  // The screens are checked with the server on every visit, and the answers
  // underneath them say so too, so a browser never draws work out of a copy it
  // already had (bw-8um.3.18).
  it('asks for the tasks without keeping them', async () => {
    mockFetch.mockResolvedValue(mockResponse({ projectId: 'p1', tasks: [] }));

    await api.tasks.list('p1');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.cache).toBe('no-store');
  });
});

describe('fetchApi error handling', () => {
  it('throws on non-OK response with error body', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ error: 'Not found' }, 404)
    );

    await expect(api.version.check()).rejects.toThrow('API error: 404 Not found');
  });

  it('throws with statusText when no JSON error body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.reject(new Error('no json')),
    } as unknown as Response);

    await expect(api.version.check()).rejects.toThrow('API error: 500 Internal Server Error');
  });
});
