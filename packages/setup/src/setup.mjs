import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32 as windowsPath } from 'node:path';

const VERSION = '0.1.0';
const SKILLS_CLI_VERSION = '1.5.18';
const API_KEY_PATTERN = /^waveInflu_[A-Za-z0-9_-]{40}$/;
const DEFAULT_AGENT = 'codex';

const usage = `WaveInflu Setup ${VERSION}

Install or update both WaveInflu Skills and configure an API Key.

Usage:
  npx @waveinflu/setup@latest [options]

Options:
  --agent <name>  Target Agent for Skills installation (default: codex)
  --reconfigure   Replace the saved API Key
  --status        Check the saved API Key without calling the API
  --help          Show this help
`;

export const getCredentialsPath = (environment = process.env, platform = process.platform) => {
  if (platform === 'win32') {
    const appData = environment.APPDATA?.trim() || windowsPath.join(homedir(), 'AppData', 'Roaming');
    return windowsPath.join(appData, 'WaveInflu', 'credentials.json');
  }

  const configHome = environment.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configHome, 'waveinflu', 'credentials.json');
};

export const parseArguments = (args) => {
  const options = { agent: DEFAULT_AGENT, reconfigure: false, status: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--reconfigure') options.reconfigure = true;
    else if (argument === '--status') options.status = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--agent') {
      const agent = args[index + 1]?.trim();
      if (!agent || agent.startsWith('-')) throw new Error('--agent requires a value.');
      options.agent = agent;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (options.status && options.reconfigure) {
    throw new Error('--status cannot be combined with --reconfigure.');
  }
  return options;
};

const validateApiKey = (value) => {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error('The API Key format is invalid. Expected waveInflu_ followed by 40 URL-safe characters.');
  }
  return apiKey;
};

export const readHiddenInput = ({ input, output, prompt }) =>
  new Promise((resolveInput, reject) => {
    const wasRaw = input.isRaw;
    let value = '';

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Setup cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolveInput(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    output.write(prompt);
  });

export const readSavedCredentials = async (path) => {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }

  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4 * 1024) {
    throw new Error('The saved credential file is unsafe or invalid. Run with --reconfigure.');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error('The saved credential file permissions are too broad. Run with --reconfigure.');
  }

  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.version !== 1) throw new Error('unsupported version');
    return validateApiKey(value.apiKey);
  } catch {
    throw new Error('The saved credential file is invalid. Run with --reconfigure.');
  }
};

export const saveCredentials = async (path, apiKey) => {
  const safeApiKey = validateApiKey(apiKey);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);

  const temporaryPath = join(directory, `.credentials-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, apiKey: safeApiKey }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    if (process.platform === 'win32') await rm(path, { force: true });
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const promptForApiKey = async () => {
  const environmentKey = process.env.WAVEINFLU_API_KEY?.trim();
  if (environmentKey) return validateApiKey(environmentKey);
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      'Interactive setup requires a terminal. Set WAVEINFLU_API_KEY for non-interactive setup.',
    );
  }

  const prompt = [
    'Open the WaveInflu extension, sign in, and select API in the right sidebar.\n',
    'Issue a Key and paste it below. Input is hidden.\n',
    'WaveInflu API Key: ',
  ].join('');
  const answer = await readHiddenInput({ input: process.stdin, output: process.stderr, prompt });
  process.stderr.write('\n');
  return validateApiKey(answer);
};

const runCommand = (command, args) =>
  new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolveCommand();
      else {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        reject(new Error(`Skills installation exited with ${reason}.`));
      }
    });
  });

const installSkills = async (agent) => {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  await runCommand(executable, [
    '--yes',
    `skills@${SKILLS_CLI_VERSION}`,
    'add',
    'WaveInflu/skills',
    '--global',
    '--agent',
    agent,
    '--skill',
    '*',
    '--yes',
  ]);
};

export const runSetup = async ({ args = process.argv.slice(2) } = {}) => {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  const credentialsPath = getCredentialsPath();
  if (options.status) {
    const savedKey = await readSavedCredentials(credentialsPath);
    process.stdout.write(
      savedKey ? 'WaveInflu API Key is configured.\n' : 'WaveInflu API Key is not configured.\n',
    );
    return;
  }

  process.stdout.write(`Installing or updating WaveInflu Skills for ${options.agent}...\n`);
  await installSkills(options.agent);

  const savedKey = options.reconfigure ? undefined : await readSavedCredentials(credentialsPath);
  if (savedKey) {
    process.stdout.write('Existing API Key kept.\nWaveInflu setup is complete. Restart your Agent.\n');
    return;
  }

  const apiKey = await promptForApiKey();
  await saveCredentials(credentialsPath, apiKey);
  process.stdout.write(
    'API Key saved with user-only permissions.\nWaveInflu setup is complete. Restart your Agent.\n',
  );
};
