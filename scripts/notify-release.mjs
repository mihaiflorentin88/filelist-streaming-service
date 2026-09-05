#!/usr/bin/env node
// Release notification for the update feed service: one bounded POST to
// the fixed sync endpoint per tagged release. stdout reports only the tag
// plus the synchronized/no-op outcome; every failure path exits nonzero
// with a neutral message. The bearer credential, request and response
// bodies, and transport errors never reach stdout or stderr.

const SYNC_ENDPOINT = 'https://filelist-ads.ffxivbard.com/api/v1/updates/sync';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2_000;
const NEUTRAL_FAILURE = 'Release notification failed.';

// Rejections a repeat attempt cannot fix: invalid request, bad credential,
// endpoint disabled, conflicting assets, oversized body, ineligible release.
// Everything else — transport errors, timeouts, 429, and 5xx — is retried
// within MAX_ATTEMPTS.
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attemptOnce(token, tag) {
  const response = await fetch(SYNC_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tag }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    // The payload only decides the log wording; it is never echoed.
    const { changed } = await response.json();
    return changed === false ? 'no-op' : 'synchronized';
  }
  return PERMANENT_STATUSES.has(response.status) ? 'permanent' : 'retry';
}

async function notify() {
  const token = process.env.RELEASE_SYNC_TOKEN ?? '';
  const tag = process.env.RELEASE_TAG ?? '';
  if (token.trim() === '' || tag.trim() === '') {
    throw new Error(NEUTRAL_FAILURE);
  }

  for (let attempt = 1; ; attempt += 1) {
    let outcome = 'retry';
    try {
      outcome = await attemptOnce(token, tag);
    } catch {
      outcome = 'retry'; // transport error or timeout: never logged
    }
    if (outcome === 'synchronized' || outcome === 'no-op') {
      const status = outcome === 'synchronized' ? 'synchronized' : 'already synchronized (no-op)';
      process.stdout.write(`Release ${tag} ${status}.\n`);
      return;
    }
    if (outcome === 'permanent' || attempt >= MAX_ATTEMPTS) {
      throw new Error(NEUTRAL_FAILURE);
    }
    await sleep(RETRY_BACKOFF_MS);
  }
}

try {
  await notify();
} catch {
  process.exitCode = 1;
  process.stderr.write(`${NEUTRAL_FAILURE}\n`);
}
