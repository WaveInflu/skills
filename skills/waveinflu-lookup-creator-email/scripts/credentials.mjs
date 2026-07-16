import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API_KEY_PATTERN = /^waveInflu_[A-Za-z0-9_-]{40}$/;
const MAX_CREDENTIAL_BYTES = 4 * 1024;

const credentialsPath = () => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'WaveInflu', 'credentials.json');
  }

  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configHome, 'waveinflu', 'credentials.json');
};

const validateApiKey = (value, source) => {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error(`${source} has an invalid API Key. Run npx @waveinflu/setup@latest --reconfigure.`);
  }
  return apiKey;
};

export const loadApiKey = async () => {
  const environmentKey = process.env.WAVEINFLU_API_KEY?.trim();
  if (environmentKey) return validateApiKey(environmentKey, 'WAVEINFLU_API_KEY');

  const path = credentialsPath();
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('WaveInflu is not configured. Run npx @waveinflu/setup@latest.');
    }
    throw error;
  }

  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CREDENTIAL_BYTES) {
    throw new Error(
      'WaveInflu credentials are unsafe or invalid. Run npx @waveinflu/setup@latest --reconfigure.',
    );
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      'WaveInflu credential permissions are too broad. Run npx @waveinflu/setup@latest --reconfigure.',
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('WaveInflu credentials are invalid. Run npx @waveinflu/setup@latest --reconfigure.');
  }

  if (credentials?.version !== 1) {
    throw new Error(
      'WaveInflu credentials use an unsupported format. Run npx @waveinflu/setup@latest --reconfigure.',
    );
  }
  return validateApiKey(credentials.apiKey, 'WaveInflu credentials');
};
