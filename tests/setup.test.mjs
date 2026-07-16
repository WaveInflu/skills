import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, win32 as windowsPath } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getCredentialsPath,
  parseArguments,
  readHiddenInput,
  readSavedCredentials,
  saveCredentials,
} from '../packages/setup/src/setup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_SCRIPT = resolve(ROOT, 'packages/setup/bin/setup.mjs');
const TEST_API_KEY = `waveInflu_${'A'.repeat(40)}`;
const REPLACEMENT_API_KEY = `waveInflu_${'B'.repeat(40)}`;

const runSetup = (args, env) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [SETUP_SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });

class FakeTerminalInput extends EventEmitter {
  constructor(events) {
    super();
    this.events = events;
    this.isRaw = false;
  }

  setEncoding(encoding) {
    this.events.push(`encoding:${encoding}`);
  }

  setRawMode(isRaw) {
    this.isRaw = isRaw;
    this.events.push(`raw:${isRaw}`);
  }

  resume() {
    this.events.push('resume');
  }

  pause() {
    this.events.push('pause');
  }
}

test('setup argument parsing stays small and explicit', () => {
  assert.deepEqual(parseArguments([]), {
    agent: 'codex',
    reconfigure: false,
    status: false,
    help: false,
  });
  assert.equal(parseArguments(['--agent', 'claude-code', '--reconfigure']).agent, 'claude-code');
  assert.equal(parseArguments(['--status']).status, true);
  assert.throws(() => parseArguments(['--agent']), /requires a value/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
  assert.throws(() => parseArguments(['--status', '--reconfigure']), /cannot be combined/);
});

test('hidden input disables terminal echo before printing the prompt', async () => {
  const events = [];
  const input = new FakeTerminalInput(events);
  let visibleOutput = '';
  const output = {
    write(value) {
      visibleOutput += value;
      events.push('prompt');
      input.emit('data', `${TEST_API_KEY}\r`);
    },
  };

  assert.equal(await readHiddenInput({ input, output, prompt: 'API Key: ' }), TEST_API_KEY);
  assert.deepEqual(events, [
    'encoding:utf8',
    'raw:true',
    'resume',
    'prompt',
    'raw:false',
    'pause',
  ]);
  assert.equal(visibleOutput, 'API Key: ');
  assert.equal(visibleOutput.includes(TEST_API_KEY), false);
});

test('credential paths follow user-level platform conventions', () => {
  assert.equal(
    getCredentialsPath({ XDG_CONFIG_HOME: '/tmp/config' }, 'darwin'),
    '/tmp/config/waveinflu/credentials.json',
  );
  assert.equal(
    getCredentialsPath({ APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' }, 'win32'),
    windowsPath.join('C:\\Users\\Example\\AppData\\Roaming', 'WaveInflu', 'credentials.json'),
  );
});

test('credentials are written atomically with user-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waveinflu-setup-'));
  const path = join(directory, 'nested', 'credentials.json');
  try {
    await saveCredentials(path, TEST_API_KEY);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved, { version: 1, apiKey: TEST_API_KEY });
    assert.equal(await readSavedCredentials(path), TEST_API_KEY);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup installs or updates on every run while preserving credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waveinflu-setup-'));
  const binDirectory = join(directory, 'bin');
  const configHome = join(directory, 'config');
  const invocationLog = join(directory, 'npx-args.jsonl');
  const fakeNpx = join(binDirectory, process.platform === 'win32' ? 'npx.cmd' : 'npx');

  try {
    await mkdir(binDirectory, { recursive: true });
    const fakeRunner = join(binDirectory, 'fake-npx.cjs');
    await writeFile(
      fakeRunner,
      [
        `const fs = require('node:fs');`,
        `fs.appendFileSync(`,
        `  process.env.WAVEINFLU_TEST_NPX_LOG,`,
        `  JSON.stringify(process.argv.slice(2)) + '\\n',`,
        `);`,
        '',
      ].join('\n'),
    );
    await writeFile(
      fakeNpx,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fakeRunner}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`,
      { mode: 0o755 },
    );
    if (process.platform !== 'win32') await chmod(fakeNpx, 0o755);

    const environment = {
      PATH: `${binDirectory}${delimiter}${process.env.PATH}`,
      XDG_CONFIG_HOME: configHome,
      APPDATA: configHome,
      WAVEINFLU_API_KEY: TEST_API_KEY,
      WAVEINFLU_TEST_NPX_LOG: invocationLog,
    };
    const first = await runSetup([], environment);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout.includes(TEST_API_KEY), false);

    const second = await runSetup([], {
      ...environment,
      WAVEINFLU_API_KEY: REPLACEMENT_API_KEY,
    });
    assert.equal(second.code, 0, second.stderr);
    const credentialPath = join(
      configHome,
      process.platform === 'win32' ? 'WaveInflu' : 'waveinflu',
      'credentials.json',
    );
    assert.equal(await readSavedCredentials(credentialPath), TEST_API_KEY);

    const third = await runSetup(['--reconfigure'], {
      ...environment,
      WAVEINFLU_API_KEY: REPLACEMENT_API_KEY,
    });
    assert.equal(third.code, 0, third.stderr);
    assert.equal(await readSavedCredentials(credentialPath), REPLACEMENT_API_KEY);

    const invocations = (await readFile(invocationLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 3);
    for (const args of invocations) {
      assert.deepEqual(args, [
        '--yes',
        'skills@1.5.18',
        'add',
        'WaveInflu/skills',
        '--global',
        '--agent',
        'codex',
        '--skill',
        '*',
        '--yes',
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('status and help never install skills or reveal credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waveinflu-setup-'));
  const configHome = join(directory, 'config');
  const credentialPath = join(
    configHome,
    process.platform === 'win32' ? 'WaveInflu' : 'waveinflu',
    'credentials.json',
  );
  try {
    await saveCredentials(credentialPath, TEST_API_KEY);
    const statusResult = await runSetup(['--status'], {
      XDG_CONFIG_HOME: configHome,
      APPDATA: configHome,
      WAVEINFLU_API_KEY: '',
      PATH: '',
    });
    assert.equal(statusResult.code, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /configured/);
    assert.equal(`${statusResult.stdout}${statusResult.stderr}`.includes(TEST_API_KEY), false);

    const helpResult = await runSetup(['--help'], { PATH: '' });
    assert.equal(helpResult.code, 0, helpResult.stderr);
    assert.match(helpResult.stdout, /npx @waveinflu\/setup@latest/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
