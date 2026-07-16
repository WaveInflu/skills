#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeInput } from './discover.mjs';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 6 * 1024 * 1024;
const MAX_CALLS = 3;
const RESULTS_PER_QUOTA = { youtube: 3, tiktok: 5, instagram: 2 };
const OUTPUT_FORMATS = new Set(['compact', 'full']);
const ATOMIC_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'discover.mjs');

class InputError extends Error {}

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

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const runAtomic = (payload) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [ATOMIC_SCRIPT], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let oversized = false;
    const append = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > MAX_CHILD_OUTPUT_BYTES) {
        oversized = true;
        child.kill('SIGTERM');
      }
      return next;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (oversized) {
        resolveRun({
          ok: false,
          error: {
            ok: false,
            requestSent: 'unknown',
            autoRetryAllowed: false,
            error: { type: 'CHILD_OUTPUT_TOO_LARGE', message: 'The atomic script output was too large.' },
          },
        });
        return;
      }
      if (code === 0) {
        const response = parseJson(stdout);
        resolveRun(response ? { ok: true, response } : {
          ok: false,
          error: {
            ok: false,
            requestSent: 'unknown',
            autoRetryAllowed: false,
            error: { type: 'INVALID_CHILD_OUTPUT', message: 'The atomic script returned invalid JSON.' },
          },
        });
        return;
      }
      resolveRun({
        ok: false,
        error: parseJson(stderr) ?? {
          ok: false,
          requestSent: 'unknown',
          autoRetryAllowed: false,
          error: { type: 'ATOMIC_SCRIPT_ERROR', message: 'The atomic script failed without a structured error.' },
        },
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });

const creatorKey = (creator, platform) =>
  platform === 'youtube' ? `youtube:${creator.channelId}` : `${platform}:${creator.userId}`;

const compactStringList = (value) => Array.isArray(value)
  ? value
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, 4)
    .map((item) => item.trim().slice(0, 60))
  : [];

const compactCreator = (creator) => {
  const contentVerticals = compactStringList(creator.contentVerticals);
  const contentFormats = compactStringList(creator.contentFormats);
  const displayName = [creator.fullName, creator.channelTitle, creator.nickname, creator.username]
    .find((value) => typeof value === 'string' && value.trim());
  return {
    username: creator.username.slice(0, 100),
    platform: creator.platform,
    platformHandle: creator.platformHandle.slice(0, 120),
    displayName: displayName.trim().slice(0, 120),
    profileUrl: creator.profileUrl.slice(0, 2_048),
    similarityScore: creator.similarityScore,
    ...(Number.isFinite(creator.followerCount) ? { followerCount: creator.followerCount } : {}),
    ...(Number.isFinite(creator.averagePlayCount) ? { averagePlayCount: creator.averagePlayCount } : {}),
    ...(Number.isFinite(creator.averageLikeCount) ? { averageLikeCount: creator.averageLikeCount } : {}),
    ...(typeof creator.region === 'string' && creator.region ? { region: creator.region } : {}),
    ...(typeof creator.language === 'string' && creator.language ? { language: creator.language } : {}),
    ...(creator.email ? { email: creator.email.slice(0, 320) } : {}),
    ...(creator.description ? { contentSummary: creator.description.slice(0, 180) } : {}),
    ...(typeof creator.gender === 'string' && creator.gender ? { gender: creator.gender } : {}),
    ...(typeof creator.ethnicity === 'string' && creator.ethnicity ? { ethnicity: creator.ethnicity } : {}),
    ...(typeof creator.creatorType === 'string' && creator.creatorType ? { creatorType: creator.creatorType } : {}),
    ...(contentVerticals.length ? { contentVerticals } : {}),
    ...(contentFormats.length ? { contentFormats } : {}),
  };
};

const rankCreators = (creators) => [...creators]
  .sort((left, right) => right.similarityScore - left.similarityScore);

const formatCreators = (creators, outputFormat) => rankCreators(creators)
  .map((creator) => outputFormat === 'compact' ? compactCreator(creator) : creator);

const main = async () => {
  const input = await readInput();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('Input must be a JSON object.');
  }

  const { maxQuotaCost, outputFormat = 'full', ...atomicInput } = input;
  if (!Number.isInteger(maxQuotaCost) || maxQuotaCost < 1) {
    throw new InputError('maxQuotaCost must be a positive integer.');
  }
  if (!OUTPUT_FORMATS.has(outputFormat)) {
    throw new InputError('outputFormat must be compact or full.');
  }

  let baseRequest;
  try {
    baseRequest = sanitizeInput(atomicInput);
  } catch (error) {
    throw new InputError(error.message);
  }

  const targetCount = baseRequest.limit;
  const ratio = RESULTS_PER_QUOTA[baseRequest.platform];
  const initialReservation = Math.ceil(targetCount / ratio);
  if (maxQuotaCost < initialReservation) {
    throw new InputError(
      `maxQuotaCost must be at least ${initialReservation} for the initial ${targetCount}-creator request.`,
    );
  }

  const creators = new Map();
  const calls = [];
  let cumulativeChargedQuota = 0;
  let cumulativeReservedQuota = 0;
  let cumulativeRefundQuota = 0;
  let lastResponse;
  let stopReason = 'max_calls_reached';

  for (let callNumber = 1; callNumber <= MAX_CALLS; callNumber += 1) {
    const remainingTarget = targetCount - creators.size;
    if (remainingTarget <= 0) {
      stopReason = 'target_reached';
      break;
    }

    const remainingBudget = maxQuotaCost - cumulativeChargedQuota;
    const requestLimit = callNumber === 1
      ? targetCount
      : Math.min(remainingTarget, remainingBudget * ratio);
    if (requestLimit < 1) {
      stopReason = 'quota_cap_reached';
      break;
    }

    const result = await runAtomic({ ...baseRequest, limit: requestLimit });
    if (!result.ok) {
      fail({
        ok: false,
        requestSent: result.error.requestSent ?? 'unknown',
        autoRetryAllowed: false,
        error: result.error.error ?? {
          type: 'ATOMIC_SCRIPT_ERROR',
          message: 'A continuation request failed. No further request was sent.',
        },
        continuation: {
          targetCount,
          completedCalls: calls.length,
          failedCall: callNumber,
          maxCalls: MAX_CALLS,
          maxQuotaCost,
          chargedQuota: cumulativeChargedQuota,
          stopReason: 'unknown_quota_outcome',
        },
        partialData: formatCreators(creators.values(), outputFormat),
      });
      return;
    }

    const response = result.response;
    const quota = response.data.quota;
    const reservation = Math.ceil(requestLimit / ratio);
    if (quota.chargedQuota > reservation || cumulativeChargedQuota + quota.chargedQuota > maxQuotaCost) {
      fail({
        ok: false,
        requestSent: true,
        autoRetryAllowed: false,
        error: {
          type: 'QUOTA_CONTRACT_VIOLATION',
          message: 'WaveInflu returned quota usage outside the local spend boundary. No further request was sent.',
        },
        partialData: formatCreators(creators.values(), outputFormat),
      });
      return;
    }

    let newUnique = 0;
    for (const creator of response.data.data) {
      const key = creatorKey(creator, baseRequest.platform);
      const existing = creators.get(key);
      if (!existing) {
        creators.set(key, creator);
        newUnique += 1;
      } else if (creator.similarityScore > existing.similarityScore) {
        creators.set(key, creator);
      }
    }

    cumulativeChargedQuota += quota.chargedQuota;
    cumulativeReservedQuota += quota.reservedQuota;
    cumulativeRefundQuota += quota.refundQuota;
    lastResponse = response;
    calls.push({
      requestId: response.data.requestId,
      requestedLimit: requestLimit,
      returnedTotal: response.data.total,
      newUnique,
      chargedQuota: quota.chargedQuota,
    });

    if (creators.size >= targetCount) {
      stopReason = 'target_reached';
      break;
    }
    if (newUnique === 0) {
      stopReason = 'no_new_unique_results';
      break;
    }
    if (cumulativeChargedQuota >= maxQuotaCost) {
      stopReason = 'quota_cap_reached';
      break;
    }
  }

  const finalCreators = rankCreators(creators.values()).slice(0, targetCount);
  const outputCreators = outputFormat === 'compact'
    ? finalCreators.map(compactCreator)
    : finalCreators;
  const lastData = lastResponse.data;
  process.stdout.write(`${JSON.stringify({
    code: 1000,
    message: 'Creator discovery completed within bounded continuation limits',
    data: {
      platform: baseRequest.platform,
      mode: lastData.mode,
      ...(lastData.seedProfileUrl ? { seedProfileUrl: lastData.seedProfileUrl } : {}),
      ...(lastData.sourceUserId ? { sourceUserId: lastData.sourceUserId } : {}),
      ...(lastData.contentDirection ? { contentDirection: lastData.contentDirection } : {}),
      targetCount,
      total: finalCreators.length,
      complete: finalCreators.length >= targetCount,
      outputFormat,
      data: outputCreators,
      continuation: {
        calls,
        maxCalls: MAX_CALLS,
        maxQuotaCost,
        stopReason,
      },
      quota: {
        totalQuota: lastData.quota.totalQuota,
        usedQuota: lastData.quota.usedQuota,
        remainingQuota: lastData.quota.remainingQuota,
        reservedQuota: cumulativeReservedQuota,
        chargedQuota: cumulativeChargedQuota,
        refundQuota: cumulativeRefundQuota,
        refundStatus: cumulativeRefundQuota > 0 ? 'completed' : 'not_required',
      },
    },
  }, null, 2)}\n`);
};

main().catch((error) => {
  fail({
    ok: false,
    requestSent: false,
    autoRetryAllowed: false,
    error: {
      type: 'LOCAL_INPUT_ERROR',
      message: error instanceof InputError ? error.message : 'The local bounded discovery script failed.',
    },
  });
});
