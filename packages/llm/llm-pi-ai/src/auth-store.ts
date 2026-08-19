import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every(item => typeof item === 'string')
}

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  return record(value) && Object.values(value).every(jsonValue)
}

function credential(value: unknown, provider: string): Credential {
  if (!record(value)) throw new Error(`llm-pi-ai auth store: invalid credential for "${provider}"`)
  if (value.type === 'api_key') {
    const fields = Object.keys(value)
    if (fields.some(field => field !== 'type' && field !== 'key' && field !== 'env')) {
      throw new Error(`llm-pi-ai auth store: unknown API-key credential field for "${provider}"`)
    }
    if (value.key !== undefined && typeof value.key !== 'string') {
      throw new Error(`llm-pi-ai auth store: invalid API-key credential for "${provider}"`)
    }
    if (value.env !== undefined && !strings(value.env)) {
      throw new Error(`llm-pi-ai auth store: invalid API-key environment for "${provider}"`)
    }
    const key = value.key === undefined
      ? undefined
      : assertUsableApiKey(value.key, 'llm-pi-ai auth store', provider)
    return {
      type: 'api_key',
      ...key === undefined ? {} : { key },
      ...value.env === undefined ? {} : { env: value.env },
    }
  }
  if (value.type === 'oauth') {
    if (typeof value.refresh !== 'string' || value.refresh.length === 0
      || typeof value.access !== 'string' || value.access.length === 0
      || typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires < 0
      || !jsonValue(value)) {
      throw new Error(`llm-pi-ai auth store: invalid OAuth credential for "${provider}"`)
    }
    return value as unknown as Credential
  }
  throw new Error(`llm-pi-ai auth store: unknown credential type for "${provider}"`)
}

function parse(content: string): Record<string, Credential> {
  const decoded: unknown = JSON.parse(content)
  if (!record(decoded)) throw new Error('llm-pi-ai auth store: root must be a JSON object')
  return Object.fromEntries(Object.entries(decoded).map(([provider, value]) => {
    if (provider.length === 0) throw new Error('llm-pi-ai auth store: provider ids must not be empty')
    return [provider, credential(value, provider)]
  }))
}

/**
 * Resolve native auth storage using explicit path, Harness home, then user home.
 * @param environment - launch-environment lookup for path overrides.
 * @param userHome - user home fallback; injectable for deterministic tests.
 * @returns absolute owner-private credential document path.
 */
export function resolvePiAiAuthPath(
  environment: (name: string) => string | undefined,
  userHome = homedir(),
): string {
  const configured = environment('DSH_PI_AI_AUTH_PATH')
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  const dshHome = environment('DSH_HOME')
  return resolve(join(dshHome !== undefined && dshHome.length > 0 ? dshHome : join(userHome, '.dsh'), 'pi-ai-auth.json'))
}

/** Owner-private, provider-keyed pi-ai credential storage. */
export class PiAiCredentialStore implements CredentialStore {
  constructor(readonly path: string) {}

  private async data(): Promise<Record<string, Credential>> {
    try {
      const info = await lstat(this.path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`llm-pi-ai auth store: ${this.path} is not a regular file`)
      if ((info.mode & 0o777) !== 0o600) {
        throw new Error(`llm-pi-ai auth store: ${this.path} must have mode 0600`)
      }
      await this.assertPrivateParent()
      return parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.data().then(data => data[providerId])
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const data = await this.data()
    return Object.entries(data).map(([providerId, value]) => ({ providerId, type: value.type }))
  }

  private async assertPrivateParent(): Promise<void> {
    const parent = dirname(this.path)
    const info = await lstat(parent)
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
      throw new Error(`llm-pi-ai auth store: ${parent} must be an owner-private directory with mode 0700`)
    }
  }

  private async prepareParent(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await this.assertPrivateParent()
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    await this.prepareParent()
    return withFileLock(this.path, async () => {
      const data = await this.data()
      const next = await fn(data[providerId])
      if (next === undefined) return data[providerId]
      const checked = credential(next, providerId)
      data[providerId] = checked
      await writeFileAtomic(this.path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return checked
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.prepareParent()
    await withFileLock(this.path, async () => {
      const data = await this.data()
      if (!(providerId in data)) return
      const remaining = Object.fromEntries(Object.entries(data).filter(([candidate]) => candidate !== providerId))
      await writeFileAtomic(this.path, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  }
}
