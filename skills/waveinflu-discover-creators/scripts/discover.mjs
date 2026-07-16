#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { loadApiKey } from './credentials.mjs';

const DEFAULT_API_ORIGIN = 'https://api.wavely.cc';
const API_PATH = '/api/v1/similar';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const CLIENT_VERSION = '0.5.0';
const TOP_LEVEL_KEYS = new Set([
  'platform',
  'seedProfileUrl',
  'contentDirection',
  'limit',
  'globalDeduplicationEnabled',
  'filters',
]);
const FILTER_KEYS = new Set([
  'regions',
  'languages',
  'minFollowers',
  'maxFollowers',
  'minVideosAverageViews',
  'maxVideosAverageViews',
  'minAverageLikeCount',
  'maxAverageLikeCount',
  'genders',
  'ethnicities',
  'creatorTypes',
]);
const INSTAGRAM_GENDERS = new Set(['male', 'female', 'unknown']);
const INSTAGRAM_ETHNICITIES = new Set([
  'white',
  'black',
  'asian',
  'hispanic_latino',
  'middle_eastern',
  'indigenous',
  'pacific_islander',
  'multiracial',
  'unknown',
]);
const INSTAGRAM_CREATOR_TYPES = new Set([
  'solo_creator',
  'couple',
  'family',
  'group',
  'product_only',
  'brand_account',
  'unknown',
]);
const ISO_ALPHA_2_REGIONS = new Set(
  [
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ',
    'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ',
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ',
    'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR',
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY',
    'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP',
    'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY',
    'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ',
    'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY',
    'QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ',
    'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ',
    'VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW',
  ].flatMap((group) => group.split(' ')),
);

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
      throw new InputError('Input exceeds 64 KiB.');
    }
  }

  if (!body.trim()) throw new InputError('Pass one JSON request object over stdin.');

  try {
    return JSON.parse(body);
  } catch {
    throw new InputError('Input must be valid JSON.');
  }
};

const assertKnownKeys = (value, allowed, label) => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new InputError(`${label} contains unsupported field: ${unknown[0]}.`);
};

const containsApiKey = (value) => {
  if (typeof value === 'string') return /waveInflu_[A-Za-z0-9_-]{20,}/.test(value);
  if (Array.isArray(value)) return value.some(containsApiKey);
  return isObject(value) && Object.values(value).some(containsApiKey);
};

const optionalText = (value, field, maxLength) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new InputError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new InputError(`${field} must be no longer than ${maxLength} characters.`);
  }
  return normalized;
};

const stringArray = (value, field, options = {}) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InputError(`${field} must be an array.`);
  if (options.maxItems && value.length > options.maxItems) {
    throw new InputError(`${field} accepts at most ${options.maxItems} values.`);
  }

  const normalized = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new InputError(`${field} must contain non-empty strings.`);
    }
    const clean = options.normalize ? options.normalize(item.trim()) : item.trim();
    if (options.maxLength && clean.length > options.maxLength) {
      throw new InputError(`${field} values must be no longer than ${options.maxLength} characters.`);
    }
    if (options.pattern && !options.pattern.test(clean)) {
      throw new InputError(`${field} contains an invalid value: ${item}.`);
    }
    if (options.allowed && !options.allowed.has(clean)) {
      throw new InputError(`${field} contains an unsupported value: ${item}.`);
    }
    return clean;
  });

  return [...new Set(normalized)];
};

const optionalInteger = (value, field) => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new InputError(`${field} must be a non-negative integer.`);
  }
  return value;
};

const validateRange = (filters, minKey, maxKey, label) => {
  if (filters[minKey] !== undefined && filters[maxKey] !== undefined && filters[minKey] > filters[maxKey]) {
    throw new InputError(`${label} minimum cannot exceed its maximum.`);
  }
};

const validateMinimum = (filters, key, minimum) => {
  if (filters[key] !== undefined && filters[key] < minimum) {
    throw new InputError(`filters.${key} cannot be lower than ${minimum}.`);
  }
};

const sanitizeSeedProfileUrl = (value, platform) => {
  const raw = optionalText(value, 'seedProfileUrl', 256);
  if (!raw) return undefined;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError('seedProfileUrl must be a valid HTTPS creator profile URL.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new InputError('seedProfileUrl must be a valid HTTPS creator profile URL.');
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');
  if (platform === 'youtube') {
    const validHost = host === 'youtube.com' || host === 'm.youtube.com';
    const validPath =
      /^\/@[A-Za-z0-9._-]{3,30}(?:\/(?:videos|shorts|streams|about|featured))?$/.test(path) ||
      /^\/channel\/UC[A-Za-z0-9_-]{20,}(?:\/(?:videos|shorts|streams|about|featured))?$/.test(path);
    if (!validHost || !validPath) {
      throw new InputError('seedProfileUrl must be a YouTube profile or channel URL.');
    }
  } else {
    const validHost = host === 'tiktok.com' || host === 'm.tiktok.com';
    if (!validHost || !/^\/@[^/?#]+$/.test(path)) {
      throw new InputError('seedProfileUrl must be a TikTok profile URL.');
    }
  }

  return platform === 'youtube'
    ? `https://www.youtube.com${path}`
    : `https://www.tiktok.com${path}`;
};

const sanitizeFilters = (value, platform) => {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new InputError('filters must be a JSON object.');
  assertKnownKeys(value, FILTER_KEYS, 'filters');

  const filters = {};
  const regions = stringArray(value.regions, 'filters.regions', {
    pattern: /^[A-Z]{2}$/,
    normalize: (item) => item.toUpperCase(),
    allowed: ISO_ALPHA_2_REGIONS,
  });
  const languages = stringArray(value.languages, 'filters.languages', {
    maxItems: 50,
    maxLength: 20,
    pattern: /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/,
    normalize: (item) => item.toLowerCase(),
  });
  if (regions?.length) filters.regions = regions;
  if (languages?.length) filters.languages = languages;

  for (const key of [
    'minFollowers',
    'maxFollowers',
    'minVideosAverageViews',
    'maxVideosAverageViews',
    'minAverageLikeCount',
    'maxAverageLikeCount',
  ]) {
    const normalized = optionalInteger(value[key], `filters.${key}`);
    if (normalized !== undefined) filters[key] = normalized;
  }

  const genders = stringArray(value.genders, 'filters.genders', { allowed: INSTAGRAM_GENDERS });
  const ethnicities = stringArray(value.ethnicities, 'filters.ethnicities', {
    allowed: INSTAGRAM_ETHNICITIES,
  });
  const creatorTypes = stringArray(value.creatorTypes, 'filters.creatorTypes', {
    allowed: INSTAGRAM_CREATOR_TYPES,
  });
  if (genders?.length) filters.genders = genders;
  if (ethnicities?.length) filters.ethnicities = ethnicities;
  if (creatorTypes?.length) filters.creatorTypes = creatorTypes;

  validateRange(filters, 'minFollowers', 'maxFollowers', 'Follower');
  validateRange(filters, 'minVideosAverageViews', 'maxVideosAverageViews', 'Average views');
  validateRange(filters, 'minAverageLikeCount', 'maxAverageLikeCount', 'Average likes');

  const followerMinimum = platform === 'tiktok' ? 1_000 : 500;
  validateMinimum(filters, 'minFollowers', followerMinimum);
  validateMinimum(filters, 'maxFollowers', followerMinimum);

  if (platform === 'instagram') {
    if (filters.minVideosAverageViews !== undefined || filters.maxVideosAverageViews !== undefined) {
      throw new InputError('Average-view filters are not supported for Instagram.');
    }
    validateMinimum(filters, 'minAverageLikeCount', 50);
    validateMinimum(filters, 'maxAverageLikeCount', 50);
  } else {
    if (
      filters.minAverageLikeCount !== undefined ||
      filters.maxAverageLikeCount !== undefined ||
      filters.genders ||
      filters.ethnicities ||
      filters.creatorTypes
    ) {
      throw new InputError('Instagram-specific filters require platform=instagram.');
    }
    const viewMinimum = platform === 'youtube' ? 2_000 : 1_000;
    validateMinimum(filters, 'minVideosAverageViews', viewMinimum);
    validateMinimum(filters, 'maxVideosAverageViews', viewMinimum);
  }

  return Object.keys(filters).length ? filters : undefined;
};

export const sanitizeInput = (input) => {
  if (!isObject(input)) throw new InputError('Input must be a JSON object.');
  assertKnownKeys(input, TOP_LEVEL_KEYS, 'Request');
  if (containsApiKey(input)) {
    throw new InputError('Do not include a WaveInflu API key in the request body.');
  }
  if (!['youtube', 'tiktok', 'instagram'].includes(input.platform)) {
    throw new InputError('platform must be youtube, tiktok, or instagram.');
  }

  const platform = input.platform;
  const contentDirection = optionalText(input.contentDirection, 'contentDirection', 800);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
    throw new InputError('limit must be an integer between 1 and 100.');
  }
  if (input.globalDeduplicationEnabled !== undefined && typeof input.globalDeduplicationEnabled !== 'boolean') {
    throw new InputError('globalDeduplicationEnabled must be a boolean.');
  }

  let seedProfileUrl;
  if (platform === 'instagram') {
    if (optionalText(input.seedProfileUrl, 'seedProfileUrl', 256)) {
      throw new InputError('Instagram does not accept seedProfileUrl; use contentDirection.');
    }
    if (!contentDirection) throw new InputError('Instagram requires contentDirection.');
  } else {
    seedProfileUrl = sanitizeSeedProfileUrl(input.seedProfileUrl, platform);
    if (!seedProfileUrl && !contentDirection) {
      throw new InputError('Provide seedProfileUrl, contentDirection, or both.');
    }
  }

  const payload = {
    platform,
    limit: input.limit ?? 25,
    globalDeduplicationEnabled: input.globalDeduplicationEnabled ?? true,
  };
  if (seedProfileUrl) payload.seedProfileUrl = seedProfileUrl;
  if (contentDirection) payload.contentDirection = contentDirection;
  const filters = sanitizeFilters(input.filters, platform);
  if (filters) payload.filters = filters;
  return payload;
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
    throw new ResponseBodyError('RESPONSE_TOO_LARGE', 'WaveInflu returned a response larger than 5 MiB.');
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
      throw new ResponseBodyError('RESPONSE_TOO_LARGE', 'WaveInflu returned a response larger than 5 MiB.');
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
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isValidCreator = (creator, platform) => {
  if (
    !isObject(creator) ||
    creator.platform !== platform ||
    !isNonEmptyString(creator.username) ||
    !isNonEmptyString(creator.platformHandle) ||
    typeof creator.description !== 'string' ||
    typeof creator.email !== 'string' ||
    !isNonEmptyString(creator.profileUrl) ||
    typeof creator.avatar !== 'string' ||
    !Number.isFinite(creator.similarityScore)
  ) {
    return false;
  }

  if (platform === 'youtube') {
    return isNonEmptyString(creator.channelId) && isNonEmptyString(creator.channelTitle);
  }
  if (platform === 'tiktok') {
    return isNonEmptyString(creator.userId) && isNonEmptyString(creator.uniqueId);
  }

  return isNonEmptyString(creator.userId);
};

const expectedMode = (request) => {
  if (!request.seedProfileUrl) return 'direction';
  return request.contentDirection ? 'homepage_direction' : 'homepage';
};

const isValidQuota = (quota) =>
  isObject(quota) &&
  isNonNegativeInteger(quota.totalQuota) &&
  isNonNegativeInteger(quota.usedQuota) &&
  isNonNegativeInteger(quota.remainingQuota) &&
  isNonNegativeInteger(quota.reservedQuota) &&
  isNonNegativeInteger(quota.chargedQuota) &&
  isNonNegativeInteger(quota.refundQuota) &&
  isNonEmptyString(quota.refundStatus);

const isValidSuccess = (response, request) => {
  if (
    !isObject(response) ||
    response.code !== 1000 ||
    typeof response.message !== 'string' ||
    !isObject(response.data)
  ) {
    return false;
  }

  const result = response.data;
  if (
    !isNonEmptyString(result.requestId) ||
    result.platform !== request.platform ||
    result.mode !== expectedMode(request) ||
    !Array.isArray(result.data) ||
    !isNonNegativeInteger(result.total) ||
    result.total !== result.data.length ||
    !result.data.every((creator) => isValidCreator(creator, request.platform)) ||
    !isValidQuota(result.quota)
  ) {
    return false;
  }

  if (request.seedProfileUrl) {
    if (
      result.seedProfileUrl !== request.seedProfileUrl ||
      !isNonEmptyString(result.sourceUserId)
    ) {
      return false;
    }
  } else if (result.seedProfileUrl !== undefined || result.sourceUserId !== undefined) {
    return false;
  }

  return request.contentDirection
    ? result.contentDirection === request.contentDirection
    : result.contentDirection === undefined;
};

const main = async () => {
  if (
    typeof fetch !== 'function' ||
    typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function'
  ) {
    throw new InputError('Node.js 22 or newer is required.');
  }

  let apiKey;
  try {
    apiKey = await loadApiKey();
  } catch (error) {
    throw new InputError(error.message);
  }

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

  if (!isValidSuccess(responsePayload, payload)) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
}
