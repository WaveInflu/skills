import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISCOVER_SCRIPT = resolve(
  ROOT,
  'skills/waveinflu-discover-creators/scripts/discover.mjs',
);
const LOOKUP_SCRIPT = resolve(
  ROOT,
  'skills/waveinflu-lookup-creator-email/scripts/lookup.mjs',
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

const runScript = (script, input, env = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        WAVEINFLU_API_KEY: TEST_API_KEY,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });

const readJsonBody = async (request) => {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
};

const discoverSuccess = {
  code: 1000,
  message: 'Similar creators completed',
  data: {
    requestId: 'req_test',
    platform: 'tiktok',
    total: 0,
    data: [],
    quota: { chargedQuota: 0, remainingQuota: 100 },
  },
};

const lookupSuccess = {
  code: 1000,
  message: 'Email lookup completed',
  data: {
    platform: 'instagram',
    username: 'example',
    profileLink: 'https://www.instagram.com/example/',
    platformUserId: null,
    region: null,
    email: null,
    emails: [],
    contacts: [],
    quota: { cost: 2, remainingQuota: 48 },
  },
};

const paidScriptCases = [
  {
    script: DISCOVER_SCRIPT,
    input: { platform: 'youtube', contentDirection: 'technology creators' },
  },
  {
    script: LOOKUP_SCRIPT,
    input: { url: 'https://www.youtube.com/@example' },
  },
];

test('both paid scripts send one sanitized request with the API key header', async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      apiKey: request.headers['x-waveinflu-api-key'],
      body: await readJsonBody(request),
    });
    const result = request.url === '/api/v1/similar' ? discoverSuccess : lookupSuccess;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });

  try {
    const discover = await runScript(
      DISCOVER_SCRIPT,
      {
        platform: 'tiktok',
        contentDirection: 'US skincare creators',
        limit: 10,
        filters: { regions: ['us', 'US'], languages: ['EN'] },
      },
      { WAVEINFLU_API_BASE_URL: server.origin },
    );
    const lookup = await runScript(
      LOOKUP_SCRIPT,
      { url: 'https://m.instagram.com/example/?hl=en' },
      { WAVEINFLU_API_BASE_URL: server.origin },
    );

    assert.equal(discover.code, 0, discover.stderr);
    assert.equal(lookup.code, 0, lookup.stderr);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests, [
      {
        path: '/api/v1/similar',
        method: 'POST',
        apiKey: TEST_API_KEY,
        body: {
          platform: 'tiktok',
          limit: 10,
          globalDeduplicationEnabled: true,
          contentDirection: 'US skincare creators',
          filters: { regions: ['US'], languages: ['en'] },
        },
      },
      {
        path: '/api/v1/email-lookup',
        method: 'POST',
        apiKey: TEST_API_KEY,
        body: { url: 'https://www.instagram.com/example/' },
      },
    ]);
    assert.equal(discover.stdout.includes(TEST_API_KEY), false);
    assert.equal(lookup.stdout.includes(TEST_API_KEY), false);
  } finally {
    await server.close();
  }
});

test('local validation rejects unsafe or contract-invalid fields before any paid request', async () => {
  let requestCount = 0;
  const server = await startServer((_request, response) => {
    requestCount += 1;
    response.end();
  });

  try {
    const inputs = [
      {
        platform: 'youtube',
        contentDirection: 'technology creators',
        WAVEINFLU_API_KEY: TEST_API_KEY,
      },
      {
        platform: 'youtube',
        contentDirection: 'technology creators',
        filters: { regions: ['ZZ'] },
      },
      {
        platform: 'youtube',
        contentDirection: 'technology creators',
        filters: { languages: ['en-abcdef12-abcdef12-ab'] },
      },
    ];
    for (const input of inputs) {
      const result = await runScript(DISCOVER_SCRIPT, input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).requestSent, false);
    }
    assert.equal(requestCount, 0);
  } finally {
    await server.close();
  }
});

test('an arbitrary API origin is rejected before the key can be sent', async () => {
  const result = await runScript(
    LOOKUP_SCRIPT,
    { url: 'https://www.youtube.com/@example' },
    { WAVEINFLU_API_BASE_URL: 'https://example.com' },
  );

  const error = JSON.parse(result.stderr);
  assert.equal(result.code, 1);
  assert.equal(error.requestSent, false);
  assert.equal(error.error.type, 'LOCAL_INPUT_ERROR');
});

test('redirects are not followed and cannot forward the API key', async () => {
  let targetRequests = 0;
  const target = await startServer((_request, response) => {
    targetRequests += 1;
    response.end(JSON.stringify(lookupSuccess));
  });
  const source = await startServer((_request, response) => {
    response.writeHead(307, { Location: `${target.origin}/capture` });
    response.end();
  });

  try {
    for (const testCase of paidScriptCases) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_BASE_URL: source.origin,
      });
      const error = JSON.parse(result.stderr);
      assert.equal(result.code, 1);
      assert.equal(error.requestSent, 'unknown');
      assert.equal(error.autoRetryAllowed, false);
    }
    assert.equal(targetRequests, 0);
  } finally {
    await source.close();
    await target.close();
  }
});

test('HTTP 429 is never retried and preserves Retry-After', async () => {
  let requestCount = 0;
  const server = await startServer((_request, response) => {
    requestCount += 1;
    response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
    response.end(
      JSON.stringify({
        code: 14029,
        message: `Rate limited: ${TEST_API_KEY}`,
        error: { detail: TEST_API_KEY },
      }),
    );
  });

  try {
    for (const testCase of paidScriptCases) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      const error = JSON.parse(result.stderr);
      assert.equal(result.code, 1);
      assert.equal(error.requestSent, true);
      assert.equal(error.autoRetryAllowed, false);
      assert.equal(error.retryAfter, '30');
      assert.equal(result.stderr.includes(TEST_API_KEY), false);
      assert.equal(result.stderr.includes('[REDACTED]'), true);
    }
    assert.equal(requestCount, 2);
  } finally {
    await server.close();
  }
});

test('a non-JSON HTTP 200 is an uncertain paid failure, not success', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('not-json');
  });

  try {
    for (const testCase of paidScriptCases) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      const error = JSON.parse(result.stderr);
      assert.equal(result.code, 1);
      assert.equal(error.requestSent, true);
      assert.equal(error.autoRetryAllowed, false);
      assert.equal(error.error.type, 'INVALID_RESPONSE');
    }
  } finally {
    await server.close();
  }
});

test('incomplete success envelopes are rejected after submission', async () => {
  const server = await startServer((request, response) => {
    const payload =
      request.url === '/api/v1/similar'
        ? { code: 1000, data: { requestId: 'req_test', platform: 'youtube', data: [], quota: {} } }
        : {
            code: 1000,
            data: { platform: 'youtube', emails: [], contacts: [], quota: {} },
          };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });

  try {
    for (const testCase of paidScriptCases) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      const error = JSON.parse(result.stderr);
      assert.equal(result.code, 1);
      assert.equal(error.requestSent, true);
      assert.equal(error.error.type, 'INVALID_RESPONSE');
    }
  } finally {
    await server.close();
  }
});

test('email lookup rejects a complete response for the wrong platform', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        code: 1000,
        data: {
          platform: 'instagram',
          username: 'wrong.creator',
          profileLink: 'https://www.instagram.com/wrong.creator/',
          platformUserId: null,
          region: null,
          email: null,
          emails: [],
          contacts: [],
          quota: { cost: 2, remainingQuota: 48 },
        },
      }),
    );
  });

  try {
    const result = await runScript(
      LOOKUP_SCRIPT,
      { url: 'https://www.youtube.com/@example' },
      { WAVEINFLU_API_BASE_URL: server.origin },
    );
    const error = JSON.parse(result.stderr);
    assert.equal(result.code, 1);
    assert.equal(error.requestSent, true);
    assert.equal(error.error.type, 'INVALID_RESPONSE');
  } finally {
    await server.close();
  }
});

test('oversized responses are rejected after one submission', async () => {
  const server = await startServer((request, response) => {
    const contentLength = request.url === '/api/v1/similar' ? 6 * 1024 * 1024 : 2 * 1024 * 1024;
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(contentLength),
    });
    response.end();
  });

  try {
    for (const testCase of paidScriptCases) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      const error = JSON.parse(result.stderr);
      assert.equal(result.code, 1);
      assert.equal(error.requestSent, true);
      assert.equal(error.error.type, 'RESPONSE_TOO_LARGE');
    }
  } finally {
    await server.close();
  }
});

test('email lookup rejects content URLs before any paid request', async () => {
  let requestCount = 0;
  const server = await startServer((_request, response) => {
    requestCount += 1;
    response.end();
  });
  const urls = [
    'https://www.youtube.com/watch?v=abc',
    'https://www.tiktok.com/@creator/video/123',
    'https://www.instagram.com/reel/ABC123/',
  ];

  try {
    for (const url of urls) {
      const result = await runScript(
        LOOKUP_SCRIPT,
        { url },
        { WAVEINFLU_API_BASE_URL: server.origin },
      );
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).requestSent, false);
    }
    assert.equal(requestCount, 0);
  } finally {
    await server.close();
  }
});

test('an interrupted response body is marked as already submitted', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"code":1000');
    setImmediate(() => response.destroy());
  });

  try {
    const result = await runScript(
      DISCOVER_SCRIPT,
      { platform: 'instagram', contentDirection: 'home fitness creators' },
      { WAVEINFLU_API_BASE_URL: server.origin },
    );
    const error = JSON.parse(result.stderr);
    assert.equal(result.code, 1);
    assert.equal(error.requestSent, true);
    assert.equal(error.autoRetryAllowed, false);
    assert.equal(error.error.type, 'RESPONSE_READ_ERROR');
  } finally {
    await server.close();
  }
});

test('skill metadata remains self-contained and names match their directories', async () => {
  const skillNames = ['waveinflu-discover-creators', 'waveinflu-lookup-creator-email'];
  for (const name of skillNames) {
    const directory = resolve(ROOT, 'skills', name);
    const skill = await readFile(resolve(directory, 'SKILL.md'), 'utf8');
    const openai = await readFile(resolve(directory, 'agents/openai.yaml'), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`, 'm'));
    assert.match(skill, /^description: .+$/m);
    assert.match(openai, new RegExp(`\\$${name}\\b`));
    await readFile(resolve(directory, 'references/api-contract.md'), 'utf8');
  }
});
