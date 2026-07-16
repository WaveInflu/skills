import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISCOVER_BOUNDED = resolve(
  ROOT,
  'skills/waveinflu-discover-creators/scripts/discover-bounded.mjs',
);
const LOOKUP_BATCH = resolve(
  ROOT,
  'skills/waveinflu-lookup-creator-email/scripts/lookup-batch.mjs',
);
const TEST_API_KEY = `waveInflu_${'A'.repeat(40)}`;

const startServer = async (handler) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
};

const runScript = (script, input, origin) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        WAVEINFLU_API_KEY: TEST_API_KEY,
        WAVEINFLU_API_BASE_URL: origin,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });

const readJsonBody = async (request) => {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
};

const creators = (count, start = 0) =>
  Array.from({ length: count }, (_, offset) => {
    const id = start + offset;
    return {
      username: `Creator ${id}`,
      platform: 'youtube',
      platformHandle: `@creator${id}`,
      description: '',
      email: '',
      profileUrl: `https://www.youtube.com/@creator${id}`,
      avatar: '',
      similarityScore: 0.9,
      channelId: `UC-${id}`,
      channelTitle: `Creator ${id}`,
    };
  });

const discoverSuccess = (request, data, callNumber) => {
  const reservedQuota = Math.ceil(request.limit / 3);
  const chargedQuota = data.length ? Math.ceil(data.length / 3) : 0;
  return {
    code: 1000,
    message: 'Similar creators completed',
    data: {
      requestId: `request-${callNumber}`,
      platform: 'youtube',
      mode: 'direction',
      contentDirection: request.contentDirection,
      total: data.length,
      data,
      quota: {
        totalQuota: 100,
        usedQuota: chargedQuota,
        remainingQuota: 100 - chargedQuota,
        reservedQuota,
        chargedQuota,
        refundQuota: reservedQuota - chargedQuota,
        refundStatus: reservedQuota > chargedQuota ? 'completed' : 'not_required',
      },
    },
  };
};

const lookupSuccess = (profileLink) => ({
  code: 1000,
  message: 'Email lookup completed',
  data: {
    platform: profileLink.includes('tiktok.com') ? 'tiktok' : 'instagram',
    username: profileLink.split('@').at(-1).replace('/', ''),
    profileLink,
    platformUserId: null,
    region: null,
    email: null,
    emails: [],
    contacts: [],
    quota: {
      cost: profileLink.includes('tiktok.com') ? 1 : 2,
      remainingQuota: 100,
    },
  },
});

test('bounded discovery continues after 31 results and completes a target of 50', async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    const data = requests.length === 1 ? creators(31) : creators(19, 31);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(discoverSuccess(body, data, requests.length)));
  });

  try {
    const result = await runScript(DISCOVER_BOUNDED, {
      platform: 'youtube',
      contentDirection: 'luxury bag creators',
      limit: 50,
      maxQuotaCost: 20,
    }, server.origin);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(requests.map(({ limit }) => limit), [50, 19]);
    assert.equal(output.data.total, 50);
    assert.equal(output.data.complete, true);
    assert.equal(output.data.continuation.stopReason, 'target_reached');
    assert.equal(output.data.quota.chargedQuota, 18);
  } finally {
    await server.close();
  }
});

test('bounded discovery stops after an unknown second request and never sends a third', async () => {
  let requestCount = 0;
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requestCount += 1;
    if (requestCount === 2) {
      response.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(discoverSuccess(body, creators(31), requestCount)));
  });

  try {
    const result = await runScript(DISCOVER_BOUNDED, {
      platform: 'youtube',
      contentDirection: 'luxury bag creators',
      limit: 50,
      maxQuotaCost: 20,
    }, server.origin);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(requestCount, 2);
    assert.equal(error.requestSent, 'unknown');
    assert.equal(error.continuation.failedCall, 2);
    assert.equal(error.partialData.length, 31);
  } finally {
    await server.close();
  }
});

test('bounded discovery stops when a continuation adds only duplicates', async () => {
  const requests = [];
  const first = creators(31);
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    const data = requests.length === 1 ? first : first.slice(0, 19);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(discoverSuccess(body, data, requests.length)));
  });

  try {
    const result = await runScript(DISCOVER_BOUNDED, {
      platform: 'youtube',
      contentDirection: 'luxury bag creators',
      limit: 50,
      maxQuotaCost: 20,
    }, server.origin);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(requests.length, 2);
    assert.equal(output.data.total, 31);
    assert.equal(output.data.continuation.stopReason, 'no_new_unique_results');
  } finally {
    await server.close();
  }
});

test('bounded discovery clips continuation work and stops at the quota cap', async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    const data = requests.length === 1 ? creators(31) : creators(body.limit, 31);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(discoverSuccess(body, data, requests.length)));
  });

  try {
    const result = await runScript(DISCOVER_BOUNDED, {
      platform: 'youtube',
      contentDirection: 'luxury bag creators',
      limit: 50,
      maxQuotaCost: 17,
    }, server.origin);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(requests.map(({ limit }) => limit), [50, 18]);
    assert.equal(output.data.total, 49);
    assert.equal(output.data.quota.chargedQuota, 17);
    assert.equal(output.data.continuation.stopReason, 'quota_cap_reached');
  } finally {
    await server.close();
  }
});

test('email batch completes 50 lookups with three-request bounded concurrency', async () => {
  let requestCount = 0;
  let active = 0;
  let peakActive = 0;
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requestCount += 1;
    active += 1;
    peakActive = Math.max(peakActive, active);
    setTimeout(() => {
      active -= 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(lookupSuccess(body.url)));
    }, 5);
  });
  const urls = Array.from({ length: 50 }, (_, index) => `https://www.tiktok.com/@creator${index}`);

  try {
    const result = await runScript(LOOKUP_BATCH, { urls, maxQuotaCost: 50 }, server.origin);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(requestCount, 50);
    assert.equal(peakActive, 3);
    assert.equal(output.data.results.length, 50);
    assert.equal(output.data.chargedQuota, 50);
  } finally {
    await server.close();
  }
});

test('email batch stops later waves after the twentieth lookup has an unknown outcome', async () => {
  const received = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    const index = Number(body.url.match(/creator(\d+)/)[1]);
    received.push(index);
    if (index === 19) {
      response.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(lookupSuccess(body.url)));
  });
  const urls = Array.from({ length: 50 }, (_, index) => `https://www.tiktok.com/@creator${index}`);

  try {
    const result = await runScript(LOOKUP_BATCH, { urls, maxQuotaCost: 50 }, server.origin);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.requestSent, 'unknown');
    assert.deepEqual(received.sort((a, b) => a - b), Array.from({ length: 21 }, (_, index) => index));
    assert.equal(error.batch.notStartedUrls.length, 29);
    assert.equal(error.partialResults.length, 20);
  } finally {
    await server.close();
  }
});

test('email batch canonicalizes and deduplicates URLs before charging', async () => {
  const received = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    received.push(body.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(lookupSuccess(body.url)));
  });

  try {
    const result = await runScript(LOOKUP_BATCH, {
      urls: [
        'instagram.com/example',
        'https://www.instagram.com/@example/reels',
        'https://m.instagram.com/example/?hl=en',
      ],
      maxQuotaCost: 2,
    }, server.origin);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(received, ['https://www.instagram.com/example/']);
    assert.equal(output.data.requestedCount, 3);
    assert.equal(output.data.uniqueCount, 1);
    assert.equal(output.data.duplicateCount, 2);
    assert.equal(output.data.chargedQuota, 2);
  } finally {
    await server.close();
  }
});
