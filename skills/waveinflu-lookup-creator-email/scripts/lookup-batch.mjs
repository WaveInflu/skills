#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalProfileUrl, platformFromProfileUrl } from './lookup.mjs';

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_URLS = 50;
const CONCURRENCY = 3;
const OUTPUT_FORMATS = new Set(['compact', 'full']);
const ATOMIC_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'lookup.mjs');

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
      throw new InputError('Input exceeds 128 KiB.');
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

const runAtomic = (url) =>
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
            requestSent: 'unknown',
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
            requestSent: 'unknown',
            error: { type: 'INVALID_CHILD_OUTPUT', message: 'The atomic script returned invalid JSON.' },
          },
        });
        return;
      }
      resolveRun({
        ok: false,
        error: parseJson(stderr) ?? {
          requestSent: 'unknown',
          error: { type: 'ATOMIC_SCRIPT_ERROR', message: 'The atomic script failed without a structured error.' },
        },
      });
    });
    child.stdin.end(JSON.stringify({ url }));
  });

const quotaCost = (url) => platformFromProfileUrl(url) === 'tiktok' ? 1 : 2;

const compactResult = (result) => {
  const emails = result.emails.slice(0, 10).map((email) => email.slice(0, 320));
  const contacts = result.contacts
    .filter((contact) => contact.url.length <= 512)
    .slice(0, 5)
    .map((contact) => ({ url: contact.url, type: contact.type.slice(0, 80) }));
  return {
    platform: result.platform,
    username: result.username?.slice(0, 100) ?? null,
    profileLink: result.profileLink.slice(0, 2_048),
    region: result.region?.slice(0, 20) ?? null,
    email: result.email?.slice(0, 320) ?? null,
    emails,
    emailCount: result.emails.length,
    contacts,
    contactCount: result.contacts.length,
    quotaCost: result.quota.cost,
  };
};

const main = async () => {
  const input = await readInput();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('Input must be a JSON object.');
  }
  const unknown = Object.keys(input).filter(
    (key) => !['urls', 'maxQuotaCost', 'outputFormat'].includes(key),
  );
  if (unknown.length) throw new InputError(`Request contains unsupported field: ${unknown[0]}.`);
  if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > MAX_URLS) {
    throw new InputError(`urls must contain between 1 and ${MAX_URLS} creator profile URLs.`);
  }
  if (!Number.isInteger(input.maxQuotaCost) || input.maxQuotaCost < 1) {
    throw new InputError('maxQuotaCost must be a positive integer.');
  }
  const outputFormat = input.outputFormat ?? 'full';
  if (!OUTPUT_FORMATS.has(outputFormat)) {
    throw new InputError('outputFormat must be compact or full.');
  }

  let canonicalUrls;
  try {
    canonicalUrls = input.urls.map(canonicalProfileUrl);
  } catch (error) {
    throw new InputError(error.message);
  }
  const urls = [...new Set(canonicalUrls)];
  const plannedQuotaCost = urls.reduce((total, url) => total + quotaCost(url), 0);
  if (plannedQuotaCost > input.maxQuotaCost) {
    throw new InputError(
      `The deduplicated batch costs ${plannedQuotaCost} email credits, above maxQuotaCost ${input.maxQuotaCost}.`,
    );
  }

  const results = [];
  let knownChargedQuota = 0;
  let lowestRemainingQuota;

  // Requests run in bounded waves so a slow unknown outcome cannot allow later waves to escape.
  for (let offset = 0; offset < urls.length; offset += CONCURRENCY) {
    const wave = urls.slice(offset, offset + CONCURRENCY);
    const outcomes = await Promise.all(wave.map(async (url) => ({ url, result: await runAtomic(url) })));
    const failures = outcomes.filter(({ result }) => !result.ok);

    for (const { url, result } of outcomes) {
      if (!result.ok) continue;
      results.push(outputFormat === 'compact' ? compactResult(result.response.data) : result.response.data);
      knownChargedQuota += result.response.data.quota.cost;
      lowestRemainingQuota = lowestRemainingQuota === undefined
        ? result.response.data.quota.remainingQuota
        : Math.min(lowestRemainingQuota, result.response.data.quota.remainingQuota);
    }

    if (failures.length) {
      const nextOffset = offset + wave.length;
      const hasUnknown = failures.some(({ result }) => result.error.requestSent === 'unknown');
      const anyRequestSent = results.length > 0 || failures.some(({ result }) => result.error.requestSent === true);
      fail({
        ok: false,
        requestSent: hasUnknown ? 'unknown' : anyRequestSent,
        autoRetryAllowed: false,
        error: {
          type: 'BATCH_STOPPED',
          message: 'A lookup failed. No later wave was sent; in-flight requests in the same wave were allowed to settle.',
        },
        batch: {
          requestedCount: input.urls.length,
          uniqueCount: urls.length,
          duplicateCount: input.urls.length - urls.length,
          concurrency: CONCURRENCY,
          maxQuotaCost: input.maxQuotaCost,
          plannedQuotaCost,
          knownChargedQuota,
          completedCount: results.length,
          failed: failures.map(({ url, result }) => ({ url, error: result.error })),
          notStartedUrls: urls.slice(nextOffset),
        },
        partialResults: results,
      });
      return;
    }
  }

  process.stdout.write(`${JSON.stringify({
    code: 1000,
    message: 'Creator email batch completed',
    data: {
      requestedCount: input.urls.length,
      uniqueCount: urls.length,
      duplicateCount: input.urls.length - urls.length,
      concurrency: CONCURRENCY,
      maxQuotaCost: input.maxQuotaCost,
      outputFormat,
      plannedQuotaCost,
      chargedQuota: knownChargedQuota,
      remainingQuota: lowestRemainingQuota,
      results,
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
      message: error instanceof InputError ? error.message : 'The local batch lookup script failed.',
    },
  });
});
