import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConfigSummary } from '../../shared/ipc';
import { createLogger } from '../logger';

const log = createLogger('config');

export const CONFIG_FILES = {
  apiKeys: ['api-keys.json'],
  resume: ['resume.txt', 'resume.md'],
  jobDescription: ['job-description.txt', 'jd.txt', 'jd.md', 'job-description.md'],
} as const;

const KNOWN_PROVIDERS = ['groq', 'cerebras', 'gemini', 'openrouter', 'openai'] as const;
type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** API keys per provider, always normalised to a (possibly empty) list. */
export type ApiKeys = Partial<Record<KnownProvider, string[]>>;

export interface AppConfig {
  apiKeys: ApiKeys;
  resume: string;
  jobDescription: string;
  autoAnswer: boolean;
}

/**
 * Accepts `"key"` or `["key1", "key2"]` per provider; anything else is ignored.
 * Array positions are preserved because Cerebras key slots carry meaning.
 */
export function normaliseApiKeys(raw: unknown): ApiKeys {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) log.warn('api-keys.json must contain a JSON object; ignoring it');
    return {};
  }

  const keys: ApiKeys = {};
  const source = raw as Record<string, unknown>;
  for (const provider of KNOWN_PROVIDERS) {
    const value = source[provider];
    if (typeof value === 'string') {
      keys[provider] = [value.trim()];
    } else if (Array.isArray(value)) {
      keys[provider] = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
    }
  }
  return keys;
}

async function readFirstExisting(filenames: readonly string[], dirs: readonly string[]): Promise<string> {
  for (const dir of dirs) {
    for (const filename of filenames) {
      try {
        return await fs.readFile(path.join(dir, filename), 'utf-8');
      } catch {
        // Try the next candidate.
      }
    }
  }
  return '';
}

/** Loads keys, resume and job description from the first directory that has each file. */
export async function loadConfig(searchDirs: readonly string[]): Promise<AppConfig> {
  let apiKeys: ApiKeys = {};
  const keysRaw = await readFirstExisting(CONFIG_FILES.apiKeys, searchDirs);
  if (keysRaw) {
    try {
      apiKeys = normaliseApiKeys(JSON.parse(keysRaw));
    } catch (error) {
      log.warn('api-keys.json is not valid JSON; continuing without keys', error);
    }
  } else {
    log.warn('No api-keys.json found in', searchDirs);
  }

  const [resume, jobDescription] = await Promise.all([
    readFirstExisting(CONFIG_FILES.resume, searchDirs),
    readFirstExisting(CONFIG_FILES.jobDescription, searchDirs),
  ]);

  const config: AppConfig = { apiKeys, resume, jobDescription, autoAnswer: true };
  log.info('Config loaded', summariseConfig(config));
  return config;
}

export function summariseConfig(config: AppConfig): ConfigSummary {
  return {
    hasAnswerKey: Boolean(config.apiKeys.cerebras?.[0] || config.apiKeys.gemini?.[0] || config.apiKeys.openrouter?.[0]),
    hasTranscriptionKey: Boolean(config.apiKeys.groq?.[0]),
    resumeLength: config.resume.length,
    jobDescriptionLength: config.jobDescription.length,
  };
}
