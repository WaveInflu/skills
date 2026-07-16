#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const DEFAULT_API_ORIGIN = 'https://api.wavely.cc';
const API_PATH = '/api/v1/email-lookup';
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const CLIENT_VERSION = '0.2.0';
const API_KEY_PATTERN = /^waveInflu_[A-Za-z0-9_-]{40}$/;
const RESERVED_INSTAGRAM_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'explore',
  'directory',
  'accounts',
  'about',
  'developer',
  'direct',
  'privacy',
  'policies',
  'legal',
  'blog',
  'support',
  'help',
  'web',
  'tv',
]);

class InputError extends Error {}

class ResponseBodyError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

let requestAttempted = false;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const fail = (payload) => {
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
};

const readInput = async () => {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
      throw new InputError('Input exceeds 8 KiB.');
    }
  }

  if (!body.trim()) throw new InputError('Pass one JSON request object over stdin.');

  try {
    return JSON.parse(body);
  } catch {
    throw new InputError('Input must be valid JSON.');
  }
};

const safeIdentity = (value, field, maxLength = 100) => {
  if (!value) throw new InputError(`${field} is missing from the creator URL.`);
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new InputError(`${field} contains invalid URL encoding.`);
  }
  if (
    !decoded ||
    decoded.length > maxLength ||
    /[\u0000-\u001f\u007f/\\?#]/u.test(decoded)
  ) {
    throw new InputError(`${field} is not a valid creator identity.`);
  }
  return value;
};

const canonicalProfileUrl = (raw) => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2_048) {
    throw new InputError('url must be a non-empty creator profile URL no longer than 2048 characters.');
  }
  if (/waveInflu_[A-Za-z0-9_-]{20,}/.test(raw)) {
    throw new InputError('Do not include a WaveInflu API key in the request body.');
  }

  let url;
  try {
    const input = raw.trim();
    if (/[\u0000-\u001f\u007f]/u.test(input)) {
      throw new InputError('url must not contain control characters.');
    }
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('url must identify an Instagram, TikTok, or YouTube creator.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new InputError('url must not contain credentials, a custom port, or a non-HTTP scheme.');
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'instagram.com' || host === 'm.instagram.com') {
    const username = segments[0]?.replace(/^@/, '');
    if (
      !username ||
      !/^[A-Za-z0-9._]{1,30}$/.test(username) ||
      RESERVED_INSTAGRAM_PATHS.has(username.toLowerCase())
    ) {
      throw new InputError('url must identify an Instagram creator, not a post or Reel.');
    }
    return `https://www.instagram.com/${username}/`;
  }

  if (host === 'tiktok.com' || host === 'm.tiktok.com') {
    const segment = segments[0];
    if (!segment?.startsWith('@')) throw new InputError('url must include a TikTok @username.');
    const username = safeIdentity(segment.slice(1), 'TikTok username');
    return `https://www.tiktok.com/@${username}`;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const [first, second] = segments;
    if (first?.startsWith('@')) {
      return `https://www.youtube.com/@${safeIdentity(first.slice(1), 'YouTube handle')}`;
    }
    if (first === 'channel') {
      const channelId = safeIdentity(
        second?.replace(/^@/, ''),
        'YouTube channel ID',
        200,
      );
      return `https://www.youtube.com/channel/${channelId}`;
    }
    if (first === 'c' || first === 'user') {
      const creatorName = safeIdentity(second?.replace(/^@/, ''), 'YouTube creator name');
      return `https://www.youtube.com/${first}/${creatorName}`;
    }
    throw new InputError('url must identify a YouTube handle, channel, custom URL, or user.');
  }

  throw new InputError('url must use an Instagram, TikTok, or YouTube host.');
};

const sanitizeInput = (input) => {
  if (!isObject(input)) throw new InputError('Input must be a JSON object.');
  const unknown = Object.keys(input).filter((key) => key !== 'url');
  if (unknown.length) throw new InputError(`Request contains unsupported field: ${unknown[0]}.`);
  return { url: canonicalProfileUrl(input.url) };
};

const buildEndpoint = () => {
  const override = process.env.WAVEINFLU_API_BASE_URL?.trim();
  if (!override) return new URL(API_PATH, DEFAULT_API_ORIGIN);

  let baseUrl;
  try {
    baseUrl = new URL(override);
  } catch {
    throw new InputError('WAVEINFLU_API_BASE_URL must be a valid URL.');
  }

  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(baseUrl.hostname);
  if (!loopback || !['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new InputError('WAVEINFLU_API_BASE_URL may only target localhost for testing.');
  }
  return new URL(API_PATH, `${baseUrl.origin}/`);
};

const readResponseBody = async (response) => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already too large; cancellation is best-effort only.
    }
    throw new ResponseBodyError('RESPONSE_TOO_LARGE', 'WaveInflu returned a response larger than 1 MiB.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The quota-charging request already completed; cancellation is best-effort only.
      }
      throw new ResponseBodyError('RESPONSE_TOO_LARGE', 'WaveInflu returned a response larger than 1 MiB.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};

const parseJson = (text) => {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const safeErrorText = (value, maxLength = 2_000) => {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  return text?.replace(/waveInflu_[A-Za-z0-9_-]{20,}/g, '[REDACTED]').slice(0, maxLength);
};

const errorResponse = (payload) => {
  if (!isObject(payload)) return undefined;
  const summary = {};
  if (typeof payload.code === 'number') summary.code = payload.code;
  if (typeof payload.code === 'string') summary.code = safeErrorText(payload.code, 256);
  const message = safeErrorText(payload.message);
  const error = safeErrorText(payload.error, 4_000);
  const requestId = safeErrorText(payload.requestId, 256);
  if (message) summary.message = message;
  if (error) summary.error = error;
  if (requestId) summary.requestId = requestId;
  return Object.keys(summary).length ? summary : undefined;
};

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const platformFromProfileUrl = (url) => {
  const host = new URL(url).hostname;
  if (host === 'www.instagram.com') return 'instagram';
  if (host === 'www.tiktok.com') return 'tiktok';
  return 'youtube';
};

const isNullableString = (value) => value === null || typeof value === 'string';

const isValidSuccess = (payload, expectedPlatform, expectedProfileUrl) => {
  if (
    !isObject(payload) ||
    payload.code !== 1000 ||
    typeof payload.message !== 'string' ||
    !isObject(payload.data) ||
    payload.data.platform !== expectedPlatform ||
    payload.data.profileLink !== expectedProfileUrl ||
    !isNullableString(payload.data.username) ||
    !isNullableString(payload.data.platformUserId) ||
    !isNullableString(payload.data.region) ||
    !isNullableString(payload.data.email) ||
    !Array.isArray(payload.data.emails) ||
    !payload.data.emails.every((email) => typeof email === 'string' && email.length > 0) ||
    !Array.isArray(payload.data.contacts) ||
    !payload.data.contacts.every(
      (contact) =>
        isObject(contact) &&
        typeof contact.url === 'string' &&
        contact.url.length > 0 &&
        typeof contact.type === 'string' &&
        contact.type.length > 0,
    ) ||
    !isObject(payload.data.quota)
  ) {
    return false;
  }

  const emails = payload.data.emails;
  return (
    new Set(emails).size === emails.length &&
    payload.data.quota.cost === (expectedPlatform === 'tiktok' ? 1 : 2) &&
    isNonNegativeInteger(payload.data.quota.remainingQuota)
  );
};

const main = async () => {
  if (
    typeof fetch !== 'function' ||
    typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function'
  ) {
    throw new InputError('Node.js 22 or newer is required.');
  }

  const apiKey = process.env.WAVEINFLU_API_KEY?.trim();
  if (!apiKey) throw new InputError('WAVEINFLU_API_KEY is not set.');
  if (!API_KEY_PATTERN.test(apiKey)) throw new InputError('WAVEINFLU_API_KEY has an invalid format.');

  const payload = sanitizeInput(await readInput());
  const endpoint = buildEndpoint();
  const correlationId = randomUUID();

  let response;
  requestAttempted = true;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `waveinflu-skills/${CLIENT_VERSION}`,
        'X-WaveInflu-Api-Key': apiKey,
        'X-Request-Id': correlationId,
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail({
      ok: false,
      requestSent: 'unknown',
      autoRetryAllowed: false,
      requestId: correlationId,
      error: {
        type: error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        message: 'The quota outcome is unknown. Do not retry automatically.',
      },
    });
    return;
  }

  let text;
  const requestId =
    safeErrorText(response.headers.get('x-request-id')?.trim(), 256) ?? correlationId;
  try {
    text = await readResponseBody(response);
  } catch (error) {
    fail({
      ok: false,
      requestSent: true,
      autoRetryAllowed: false,
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      error: {
        type: error instanceof ResponseBodyError ? error.type : 'RESPONSE_READ_ERROR',
        message: 'The response could not be read, so the quota outcome is unknown. Do not retry automatically.',
      },
    });
    return;
  }

  const responsePayload = parseJson(text);
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after')?.trim();
    const responseError = errorResponse(responsePayload);
    fail({
      ok: false,
      requestSent: true,
      autoRetryAllowed: false,
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      ...(retryAfter ? { retryAfter } : {}),
      ...(responseError ? { response: responseError } : {}),
      error: { type: 'HTTP_ERROR', message: `WaveInflu API returned HTTP ${response.status}.` },
    });
    return;
  }

  if (!isValidSuccess(responsePayload, platformFromProfileUrl(payload.url), payload.url)) {
    fail({
      ok: false,
      requestSent: true,
      autoRetryAllowed: false,
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      error: {
        type: 'INVALID_RESPONSE',
        message: 'WaveInflu returned an unexpected success response. Do not retry automatically.',
      },
    });
    return;
  }

  process.stdout.write(`${JSON.stringify(responsePayload, null, 2)}\n`);
};

main().catch((error) => {
  const localInputError = error instanceof InputError && !requestAttempted;
  fail({
    ok: false,
    requestSent: requestAttempted ? 'unknown' : false,
    autoRetryAllowed: false,
    error: {
      type: localInputError ? 'LOCAL_INPUT_ERROR' : 'LOCAL_SCRIPT_ERROR',
      message: localInputError ? error.message : 'The local WaveInflu script failed.',
    },
  });
});
