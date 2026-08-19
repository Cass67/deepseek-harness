import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiAiCredentialStore, resolvePiAiAuthPath } from '../src/auth-store.ts'

describe('PiAiCredentialStore', () => {
  it('resolves explicit path before Harness home and user home', () => {
    expect(resolvePiAiAuthPath(name => ({
      DSH_PI_AI_AUTH_PATH: './private/auth.json',
      DSH_HOME: '/ignored',
    })[name], '/home/user')).toBe(join(process.cwd(), 'private', 'auth.json'))
    expect(resolvePiAiAuthPath(name => name === 'DSH_HOME' ? '/dsh' : undefined, '/home/user'))
      .toBe('/dsh/pi-ai-auth.json')
    expect(resolvePiAiAuthPath(() => undefined, '/home/user')).toBe('/home/user/.dsh/pi-ai-auth.json')
  })

  it('persists strict provider credentials privately and serializes concurrent modifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pi-auth-'))
    const path = join(root, 'private', 'auth.json')
    const first = new PiAiCredentialStore(path)
    const second = new PiAiCredentialStore(path)
    await Promise.all([
      first.modify('openai', async () => ({ type: 'api_key', key: 'one' })),
      second.modify('anthropic', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })),
    ])
    expect([...(await first.list())].sort((left, right) => left.providerId.localeCompare(right.providerId))).toEqual([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai', type: 'api_key' },
    ])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'private'))).mode & 0o777).toBe(0o700)
    expect(await readFile(path, 'utf8')).not.toContain('undefined')
    await second.delete('openai')
    expect(await first.read('openai')).toBeUndefined()
    expect(await first.read('anthropic')).toMatchObject({ type: 'oauth' })
  })

  it('refuses a broad parent rather than changing arbitrary directory permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pi-auth-parent-'))
    const broad = join(root, 'shared')
    const path = join(broad, 'auth.json')
    await mkdir(broad, { mode: 0o755 })
    await writeFile(path, '{}', { mode: 0o600 })
    const store = new PiAiCredentialStore(path)
    await expect(store.list()).rejects.toThrow('owner-private directory')
    await expect(store.modify(
      'openai', async () => ({ type: 'api_key', key: 'secret' }),
    )).rejects.toThrow('owner-private directory')
    expect((await stat(broad)).mode & 0o777).toBe(0o755)
  })

  it('refuses malformed and overly broad credential files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pi-auth-invalid-'))
    const path = join(root, 'auth.json')
    await writeFile(path, '{"openai":{"type":"oauth","access":"secret"}}', { mode: 0o600 })
    await expect(new PiAiCredentialStore(path).read('openai')).rejects.toThrow('invalid OAuth credential')
    await writeFile(path, '{"openai":{"type":"api_key","key":"secret","extra":true}}', { mode: 0o600 })
    await expect(new PiAiCredentialStore(path).read('openai')).rejects.toThrow('unknown API-key credential field')
    await writeFile(path, '{"openai":{"type":"oauth","access":"a","refresh":"r","expires":1,"extra":null}}', { mode: 0o600 })
    expect(await new PiAiCredentialStore(path).read('openai')).toMatchObject({ type: 'oauth', extra: null })
    await writeFile(path, '{}')
    await chmod(path, 0o400)
    await expect(new PiAiCredentialStore(path).list()).rejects.toThrow('must have mode 0600')
    await chmod(path, 0o644)
    await expect(new PiAiCredentialStore(path).list()).rejects.toThrow('must have mode 0600')
    const link = join(root, 'linked.json')
    await symlink(path, link)
    await expect(new PiAiCredentialStore(link).list()).rejects.toThrow('not a regular file')
  })
})
