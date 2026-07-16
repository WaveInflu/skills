import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
const YOUTUBE_SEED = `https://www.youtube.com/channel/UC${'A'.repeat(20)}`;
const RESULTS_PER_QUOTA = { youtube: 3, tiktok: 5, instagram: 2 };

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
    const childEnvironment = {
      ...process.env,
      WAVEINFLU_API_KEY: TEST_API_KEY,
      ...env,
    };
    for (const [key, value] of Object.entries(childEnvironment)) {
      if (value === undefined) delete childEnvironment[key];
    }
    const child = spawn(process.execPath, [script], {
      env: childEnvironment,
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

const creatorFor = (platform) => {
  const common = {
    username: 'Example Creator',
    platform,
    platformHandle: '@example',
    description: 'Skincare reviews and routines',
    email: '',
    profileUrl: `https://www.${platform}.com/@example`,
    avatar: '',
    similarityScore: 0.91,
    followerCount: 20_000,
    averagePlayCount: 8_000,
    averageLikeCount: 900,
    lastPublishedTime: 1_750_000_000,
    region: 'US',
    language: 'en',
  };

  if (platform === 'youtube') {
    return {
      ...common,
      profileUrl: 'https://www.youtube.com/@example',
      channelId: `UC${'B'.repeat(20)}`,
      channelTitle: 'Example Creator',
    };
  }
  if (platform === 'tiktok') {
    return { ...common, userId: 'tt-123', uniqueId: 'example', nickname: 'Example Creator' };
  }
  return {
    ...common,
    profileUrl: 'https://www.instagram.com/example/',
    userId: 'ig-123',
    fullName: 'Example Creator',
    biography: 'Public creator biography',
    followingCount: 400,
    gender: 'female',
    ethnicity: 'asian',
    creatorType: 'solo_creator',
    faceVisibility: 'clear_face',
    contentVerticals: ['beauty'],
    contentFormats: ['tutorial'],
    visualStyles: ['bright'],
  };
};

const minimalCreatorFor = (platform) => {
  const common = {
    username: 'Example Creator',
    platform,
    platformHandle: '@example',
    description: '',
    email: '',
    profileUrl: `https://www.${platform}.com/@example`,
    avatar: '',
    similarityScore: 0.91,
  };
  if (platform === 'youtube') {
    return { ...common, channelId: 'UC-minimal', channelTitle: 'Example Creator' };
  }
  if (platform === 'tiktok') {
    return { ...common, userId: 'tt-minimal', uniqueId: 'example' };
  }
  return {
    ...common,
    profileUrl: 'https://www.instagram.com/example/',
    userId: 'ig-minimal',
  };
};

const discoverSuccess = (request, creators = [creatorFor(request.platform)]) => {
  const ratio = RESULTS_PER_QUOTA[request.platform];
  const reservedQuota = Math.ceil(request.limit / ratio);
  const chargedQuota = creators.length ? Math.ceil(creators.length / ratio) : 0;
  const refundQuota = reservedQuota - chargedQuota;
  const mode = request.seedProfileUrl
    ? request.contentDirection
      ? 'homepage_direction'
      : 'homepage'
    : 'direction';
  return {
    code: 1000,
    message: 'Similar creators completed',
    data: {
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      platform: request.platform,
      mode,
      ...(request.seedProfileUrl
        ? { seedProfileUrl: request.seedProfileUrl, sourceUserId: 'source-123' }
        : {}),
      ...(request.contentDirection ? { contentDirection: request.contentDirection } : {}),
      total: creators.length,
      data: creators,
      quota: {
        totalQuota: 100,
        usedQuota: chargedQuota,
        remainingQuota: 100 - chargedQuota,
        reservedQuota,
        chargedQuota,
        refundQuota,
        refundStatus: refundQuota > 0 ? 'completed' : 'not_required',
      },
    },
  };
};

const platformFromProfile = (profileLink) => {
  const host = new URL(profileLink).hostname;
  if (host === 'www.instagram.com') return 'instagram';
  if (host === 'www.tiktok.com') return 'tiktok';
  return 'youtube';
};

const lookupSuccess = (profileLink, options = {}) => {
  const platform = platformFromProfile(profileLink);
  const emails = options.emails ?? ['hello@example.test', 'team@example.test'];
  return {
    code: 1000,
    message: 'Email lookup completed',
    data: {
      platform,
      username: options.username === undefined ? 'example' : options.username,
      profileLink,
      platformUserId: options.platformUserId ?? null,
      region: options.region === undefined ? 'US' : options.region,
      email: options.email === undefined ? emails[0] ?? null : options.email,
      emails,
      contacts: options.contacts ?? [{ url: 'https://example.test', type: 'website' }],
      quota: { cost: platform === 'tiktok' ? 1 : 2, remainingQuota: 48 },
    },
  };
};

const quotaCases = [
  {
    script: DISCOVER_SCRIPT,
    input: { platform: 'youtube', contentDirection: 'technology creators' },
  },
  {
    script: LOOKUP_SCRIPT,
    input: { url: 'https://www.youtube.com/@example' },
  },
];

test('both scripts send one sanitized request with the API key header', async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({
      path: request.url,
      method: request.method,
      apiKey: request.headers['x-waveinflu-api-key'],
      requestId: request.headers['x-request-id'],
      body,
    });
    const result =
      request.url === '/api/v1/similar' ? discoverSuccess(body) : lookupSuccess(body.url);
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
      { url: 'm.instagram.com/example/reels?hl=en' },
      { WAVEINFLU_API_BASE_URL: server.origin },
    );

    assert.equal(discover.code, 0, discover.stderr);
    assert.equal(lookup.code, 0, lookup.stderr);
    assert.deepEqual(requests, [
      {
        path: '/api/v1/similar',
        method: 'POST',
        apiKey: TEST_API_KEY,
        requestId: requests[0].requestId,
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
        requestId: requests[1].requestId,
        body: { url: 'https://www.instagram.com/example/' },
      },
    ]);
    assert.match(requests[0].requestId, /^[0-9a-f-]{36}$/);
    assert.match(requests[1].requestId, /^[0-9a-f-]{36}$/);
    assert.equal(discover.stdout.includes(TEST_API_KEY), false);
    assert.equal(lookup.stdout.includes(TEST_API_KEY), false);
  } finally {
    await server.close();
  }
});

test('creator discovery accepts complete contracts for every platform and mode', async () => {
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(discoverSuccess(body)));
  });
  const cases = [
    { platform: 'youtube', seedProfileUrl: YOUTUBE_SEED, limit: 3 },
    { platform: 'youtube', contentDirection: 'consumer technology explainers', limit: 3 },
    {
      platform: 'youtube',
      seedProfileUrl: 'https://www.youtube.com/@example/videos',
      contentDirection: 'practical camera reviews',
      limit: 4,
    },
    { platform: 'tiktok', contentDirection: 'home fitness routines', limit: 5 },
    { platform: 'tiktok', seedProfileUrl: 'https://m.tiktok.com/@example', limit: 6 },
    {
      platform: 'tiktok',
      seedProfileUrl: 'https://www.tiktok.com/@example',
      contentDirection: 'practical home workouts',
      limit: 6,
    },
    {
      platform: 'instagram',
      contentDirection: 'minimalist fashion creators',
      limit: 2,
      filters: { minAverageLikeCount: 50, genders: ['female'] },
    },
  ];

  try {
    for (const input of cases) {
      const result = await runScript(DISCOVER_SCRIPT, input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.data.platform, input.platform);
      assert.equal(payload.data.total, 1);
    }
  } finally {
    await server.close();
  }
});

test('creator discovery accepts minimal creator objects for every platform', async () => {
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(discoverSuccess(body, [minimalCreatorFor(body.platform)])));
  });

  try {
    for (const platform of ['youtube', 'tiktok', 'instagram']) {
      const result = await runScript(
        DISCOVER_SCRIPT,
        { platform, contentDirection: 'sustainable lifestyle creators', limit: 3 },
        { WAVEINFLU_API_BASE_URL: server.origin },
      );
      assert.equal(result.code, 0, result.stderr);
    }
  } finally {
    await server.close();
  }
});

test('creator discovery accepts contract boundaries and a zero-result full refund', async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(discoverSuccess(body, [])));
  });

  try {
    const inputs = [
      { platform: 'youtube', contentDirection: 'a'.repeat(800), limit: 1 },
      {
        platform: 'instagram',
        contentDirection: 'beauty creators',
        limit: 100,
        filters: { languages: Array.from({ length: 50 }, (_, index) => `aa-a${index}`) },
      },
    ];
    for (const input of inputs) {
      const result = await runScript(DISCOVER_SCRIPT, input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).data.quota.chargedQuota, 0);
    }
    assert.equal(requests.length, 2);
  } finally {
    await server.close();
  }
});

test('creator discovery rejects unsafe or contract-invalid input before submission', async () => {
  let requestCount = 0;
  const server = await startServer((_request, response) => {
    requestCount += 1;
    response.end();
  });
  const inputs = [
    { platform: 'youtube', contentDirection: 'tech', extra: true },
    { platform: 'youtube', contentDirection: `contains ${TEST_API_KEY}` },
    { platform: 'youtube', contentDirection: 'tech', filters: { regions: ['ZZ'] } },
    { platform: 'youtube', contentDirection: 'tech', filters: { minFollowers: 499 } },
    { platform: 'tiktok', contentDirection: 'tech', filters: { genders: ['female'] } },
    { platform: 'instagram', seedProfileUrl: 'https://www.instagram.com/example/' },
    { platform: 'instagram', contentDirection: 'x'.repeat(801) },
    { platform: 'tiktok', seedProfileUrl: 'https://www.tiktok.com/@example/video/123' },
  ];

  try {
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

test('creator discovery rejects incomplete or inconsistent success responses', async () => {
  const input = { platform: 'youtube', contentDirection: 'technology creators', limit: 3 };
  const valid = discoverSuccess({
    ...input,
    globalDeduplicationEnabled: true,
  });
  const variants = [
    (() => {
      const value = structuredClone(valid);
      delete value.data.mode;
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      delete value.data.quota.reservedQuota;
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      delete value.data.data[0].channelId;
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.data.data[0].platform = 'tiktok';
      return value;
    })(),
  ];
  let index = 0;
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(variants[index++]));
  });

  try {
    for (const _variant of variants) {
      const result = await runScript(DISCOVER_SCRIPT, input, {
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

test('email lookup canonicalizes all supported creator URL forms', async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(lookupSuccess(body.url)));
  });
  const cases = [
    ['instagram.com/example/reels?hl=en', 'https://www.instagram.com/example/'],
    ['instagram.com/@example/reels?hl=en', 'https://www.instagram.com/example/'],
    ['http://m.tiktok.com/@creator/video/123', 'https://www.tiktok.com/@creator'],
    ['youtube.com/@中文/videos', 'https://www.youtube.com/@%E4%B8%AD%E6%96%87'],
    ['https://m.youtube.com/channel/UC123/videos', 'https://www.youtube.com/channel/UC123'],
    ['https://www.youtube.com/c/example/about', 'https://www.youtube.com/c/example'],
    ['https://www.youtube.com/user/example/playlists', 'https://www.youtube.com/user/example'],
    ['https://www.youtube.com/channel/@UC456/videos', 'https://www.youtube.com/channel/UC456'],
    ['https://www.youtube.com/c/@creator/about', 'https://www.youtube.com/c/creator'],
    ['https://www.youtube.com/user/@creator/playlists', 'https://www.youtube.com/user/creator'],
  ];

  try {
    for (const [url, expected] of cases) {
      const result = await runScript(LOOKUP_SCRIPT, { url }, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).data.profileLink, expected);
    }
    assert.deepEqual(requests, cases.map(([, expected]) => expected));
  } finally {
    await server.close();
  }
});

test('email lookup accepts no-email success and complete public contact data', async () => {
  const responses = [
    lookupSuccess('https://www.instagram.com/example/', {
      emails: [],
      email: null,
      contacts: [],
      username: null,
      region: null,
    }),
    lookupSuccess('https://www.tiktok.com/@example'),
  ];
  let index = 0;
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responses[index++]));
  });

  try {
    const empty = await runScript(LOOKUP_SCRIPT, { url: 'instagram.com/example' }, {
      WAVEINFLU_API_BASE_URL: server.origin,
    });
    const complete = await runScript(LOOKUP_SCRIPT, { url: 'tiktok.com/@example' }, {
      WAVEINFLU_API_BASE_URL: server.origin,
    });
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(JSON.parse(empty.stdout).data.email, null);
    assert.equal(complete.code, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).data.quota.cost, 1);
  } finally {
    await server.close();
  }
});

test('email lookup rejects unsupported, ambiguous, or batch input before submission', async () => {
  let requestCount = 0;
  const server = await startServer((_request, response) => {
    requestCount += 1;
    response.end();
  });
  const urls = [
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'https://www.instagram.com/reel/ABC123/',
    'https://user:pass@www.tiktok.com/@creator',
    'https://www.instagram.com:8443/example/',
    'https://www.instagram.com/exam\nple/',
    'https://www.tiktok.com/@exam\tple',
    'https://www.youtube.com/@exam\rple',
    'Example Creator',
  ];

  try {
    for (const url of urls) {
      const result = await runScript(LOOKUP_SCRIPT, { url }, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).requestSent, false);
    }
    for (const input of [
      { url: ['https://www.instagram.com/one/', 'https://www.instagram.com/two/'] },
      [
        { url: 'https://www.instagram.com/one/' },
        { url: 'https://www.instagram.com/two/' },
      ],
    ]) {
      const result = await runScript(LOOKUP_SCRIPT, input, {
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

test('email lookup rejects inconsistent success data', async () => {
  const valid = lookupSuccess('https://www.youtube.com/@example');
  const variants = [
    { ...valid, data: { ...valid.data, platform: 'instagram' } },
    { ...valid, data: { ...valid.data, profileLink: 'https://www.youtube.com/@other' } },
    { ...valid, data: { ...valid.data, contacts: [{ url: '', type: 'website' }] } },
    { ...valid, data: { ...valid.data, emails: ['hello@example.test', 'hello@example.test'] } },
    { ...valid, data: { ...valid.data, quota: { cost: 1, remainingQuota: 49 } } },
  ];
  let index = 0;
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(variants[index++]));
  });

  try {
    for (const _variant of variants) {
      const result = await runScript(LOOKUP_SCRIPT, { url: 'youtube.com/@example' }, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).error.type, 'INVALID_RESPONSE');
    }
  } finally {
    await server.close();
  }
});

test('missing or malformed API keys fail locally', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'waveinflu-empty-config-'));
  try {
    for (const [script, input] of [
      [DISCOVER_SCRIPT, { platform: 'youtube', contentDirection: 'technology' }],
      [LOOKUP_SCRIPT, { url: 'youtube.com/@example' }],
    ]) {
      for (const key of ['', 'waveInflu_short']) {
        const result = await runScript(script, input, {
          WAVEINFLU_API_KEY: key,
          XDG_CONFIG_HOME: configHome,
          APPDATA: configHome,
        });
        const error = JSON.parse(result.stderr);
        assert.equal(result.code, 1);
        assert.equal(error.requestSent, false);
        assert.equal(error.error.type, 'LOCAL_INPUT_ERROR');
      }
    }
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test('both scripts load user-level credentials when no environment override exists', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'waveinflu-config-'));
  const credentialDirectory = join(
    configHome,
    process.platform === 'win32' ? 'WaveInflu' : 'waveinflu',
  );
  const credentialPath = join(credentialDirectory, 'credentials.json');
  const receivedKeys = [];
  const server = await startServer(async (request, response) => {
    receivedKeys.push(request.headers['x-waveinflu-api-key']);
    const body = await readJsonBody(request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify(
        request.url === '/api/v1/similar'
          ? discoverSuccess(body)
          : lookupSuccess(body.url),
      ),
    );
  });

  try {
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      credentialPath,
      `${JSON.stringify({ version: 1, apiKey: TEST_API_KEY })}\n`,
      { mode: 0o600 },
    );
    for (const testCase of quotaCases) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_KEY: undefined,
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(receivedKeys, [TEST_API_KEY, TEST_API_KEY]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test('environment credentials override the saved user credential', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'waveinflu-config-'));
  const credentialDirectory = join(
    configHome,
    process.platform === 'win32' ? 'WaveInflu' : 'waveinflu',
  );
  const environmentKey = `waveInflu_${'B'.repeat(40)}`;
  let receivedKey;
  const server = await startServer(async (request, response) => {
    receivedKey = request.headers['x-waveinflu-api-key'];
    const body = await readJsonBody(request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(lookupSuccess(body.url)));
  });

  try {
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(credentialDirectory, 'credentials.json'),
      `${JSON.stringify({ version: 1, apiKey: TEST_API_KEY })}\n`,
      { mode: 0o600 },
    );
    const result = await runScript(LOOKUP_SCRIPT, { url: 'youtube.com/@example' }, {
      WAVEINFLU_API_KEY: environmentKey,
      XDG_CONFIG_HOME: configHome,
      APPDATA: configHome,
      WAVEINFLU_API_BASE_URL: server.origin,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(receivedKey, environmentKey);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test('unsafe or invalid saved credentials fail before a request is submitted', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'waveinflu-config-'));
  const credentialDirectory = join(
    configHome,
    process.platform === 'win32' ? 'WaveInflu' : 'waveinflu',
  );
  const credentialPath = join(credentialDirectory, 'credentials.json');
  let requestCount = 0;
  const server = await startServer((_request, response) => {
    requestCount += 1;
    response.end();
  });

  try {
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await writeFile(credentialPath, '{"version":1,"apiKey":"invalid"}\n', { mode: 0o600 });
    for (const script of [DISCOVER_SCRIPT, LOOKUP_SCRIPT]) {
      const input = script === DISCOVER_SCRIPT
        ? { platform: 'youtube', contentDirection: 'technology' }
        : { url: 'youtube.com/@example' };
      const result = await runScript(script, input, {
        WAVEINFLU_API_KEY: undefined,
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).requestSent, false);
    }

    if (process.platform !== 'win32') {
      await writeFile(
        credentialPath,
        `${JSON.stringify({ version: 1, apiKey: TEST_API_KEY })}\n`,
        { mode: 0o600 },
      );
      await chmod(credentialPath, 0o644);
      const unsafe = await runScript(LOOKUP_SCRIPT, { url: 'youtube.com/@example' }, {
        WAVEINFLU_API_KEY: undefined,
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      assert.equal(unsafe.code, 1);
      assert.match(JSON.parse(unsafe.stderr).error.message, /permissions/i);
    }
    assert.equal(requestCount, 0);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
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

test('redirects are never followed and cannot forward the API key', async () => {
  let targetRequests = 0;
  const sourceRequestIds = [];
  const target = await startServer((_request, response) => {
    targetRequests += 1;
    response.end();
  });
  const source = await startServer((request, response) => {
    sourceRequestIds.push(request.headers['x-request-id']);
    response.writeHead(307, { Location: `${target.origin}/capture` });
    response.end();
  });

  try {
    for (const [index, testCase] of quotaCases.entries()) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_BASE_URL: source.origin,
      });
      const error = JSON.parse(result.stderr);
      assert.equal(result.code, 1);
      assert.equal(error.requestSent, 'unknown');
      assert.equal(error.autoRetryAllowed, false);
      assert.equal(error.requestId, sourceRequestIds[index]);
    }
    assert.equal(targetRequests, 0);
  } finally {
    await source.close();
    await target.close();
  }
});

test('HTTP errors are returned once, sanitized, and include diagnostic headers', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Request-Id': `edge-${status}`,
        ...(status === 429 ? { 'Retry-After': '30' } : {}),
      });
      response.end(
        JSON.stringify({
          code: status === 401 ? 1413 : status === 403 ? 1403 : 1500,
          message: `Rejected ${TEST_API_KEY}`,
          error: { detail: TEST_API_KEY },
        }),
      );
    });

    try {
      for (const testCase of quotaCases) {
        const result = await runScript(testCase.script, testCase.input, {
          WAVEINFLU_API_BASE_URL: server.origin,
        });
        const error = JSON.parse(result.stderr);
        assert.equal(result.code, 1);
        assert.equal(error.requestSent, true);
        assert.equal(error.autoRetryAllowed, false);
        assert.equal(error.requestId, `edge-${status}`);
        assert.equal(result.stderr.includes(TEST_API_KEY), false);
        assert.equal(result.stderr.includes('[REDACTED]'), true);
        if (status === 429) assert.equal(error.retryAfter, '30');
      }
      assert.equal(requestCount, 2);
    } finally {
      await server.close();
    }
  }
});

test('malformed and oversized success responses remain one uncertain submission', async () => {
  const responders = [
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'X-Request-Id': 'bad-json' });
      response.end('not-json');
    },
    (request, response) => {
      const contentLength =
        request.url === '/api/v1/similar' ? 6 * 1024 * 1024 : 2 * 1024 * 1024;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(contentLength),
      });
      response.end();
    },
  ];

  for (const responder of responders) {
    const server = await startServer(responder);
    try {
      for (const testCase of quotaCases) {
        const result = await runScript(testCase.script, testCase.input, {
          WAVEINFLU_API_BASE_URL: server.origin,
        });
        const error = JSON.parse(result.stderr);
        assert.equal(result.code, 1);
        assert.equal(error.requestSent, true);
        assert.equal(error.autoRetryAllowed, false);
        assert.ok(['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(error.error.type));
      }
    } finally {
      await server.close();
    }
  }
});

test('interrupted response bodies are marked as already submitted', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'interrupted' });
    response.write('{"code":1000');
    setImmediate(() => response.destroy());
  });

  try {
    for (const testCase of quotaCases) {
      const result = await runScript(testCase.script, testCase.input, {
        WAVEINFLU_API_BASE_URL: server.origin,
      });
      const error = JSON.parse(result.stderr);
      assert.equal(result.code, 1);
      assert.equal(error.requestSent, true);
      assert.equal(error.requestId, 'interrupted');
      assert.equal(error.error.type, 'RESPONSE_READ_ERROR');
    }
  } finally {
    await server.close();
  }
});

test('skill metadata remains self-contained and names match their directories', async () => {
  const skillNames = ['waveinflu-discover-creators', 'waveinflu-lookup-creator-email'];
  for (const name of skillNames) {
    const directory = resolve(ROOT, 'skills', name);
    const skill = (await readFile(resolve(directory, 'SKILL.md'), 'utf8')).replaceAll('\r\n', '\n');
    const openai = await readFile(resolve(directory, 'agents/openai.yaml'), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`, 'm'));
    assert.match(skill, /^description: .+$/m);
    assert.match(openai, new RegExp(`\\$${name}\\b`));
    await readFile(resolve(directory, 'references/api-contract.md'), 'utf8');
    await readFile(resolve(directory, 'scripts/credentials.mjs'), 'utf8');
  }
  assert.equal(
    await readFile(
      resolve(ROOT, 'skills/waveinflu-discover-creators/scripts/credentials.mjs'),
      'utf8',
    ),
    await readFile(
      resolve(ROOT, 'skills/waveinflu-lookup-creator-email/scripts/credentials.mjs'),
      'utf8',
    ),
  );
});
