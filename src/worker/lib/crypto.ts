import type { Env } from '../env'
import { ApiError } from './errors'
import { isValidId } from './id'


const VAULT_NAME = 'primary'
const VAULT_ORIGIN = 'https://credential-vault.internal'

export class CryptoUnavailableError extends ApiError {
  constructor() {
    super(
      503,
      'server_misconfigured',
      'The server is missing the CREDENTIAL_VAULT Durable Object binding and cannot store sensitive credentials safely',
    )
    this.name = 'CryptoUnavailableError'
  }
}

export async function encryptSecret(env: Env, info: string, value: unknown): Promise<string> {
  if (!isValidId(info)) throw new Error('invalid_credential_scope')
  return encryptCredential(env, `backup:${info}`, value)
}

export async function decryptSecret<T>(env: Env, info: string, stored: string): Promise<T | null> {
  if (!isValidId(info) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `backup:${info}`, stored)
  return isBackupCredentialRecord(value) ? (value as T) : null
}

export async function encryptTotpSecret(env: Env, userId: string, secret: string): Promise<string> {
  if (!isValidId(userId) || !/^[A-Z2-7]{32}$/.test(secret)) {
    throw new Error('invalid_totp_credential')
  }
  return encryptCredential(env, `totp:${userId}`, { secret })
}

export async function decryptTotpSecret(
  env: Env,
  userId: string,
  stored: string,
): Promise<string | null> {
  if (!isValidId(userId) || stored.length > 24 * 1024) return null
  const value = await decryptCredential(env, `totp:${userId}`, stored)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const secret = (value as Record<string, unknown>).secret
  return typeof secret === 'string' && /^[A-Z2-7]{32}$/.test(secret) ? secret : null
}

async function encryptCredential(env: Env, scope: string, value: unknown): Promise<string> {
  const response = await vaultRequest(env, '/encrypt', { scope, value })
  if (!response.ok) throw new CryptoUnavailableError()
  const body: unknown = await response.json().catch(() => null)
  const ciphertext = readStringField(body, 'ciphertext')
  if (!ciphertext || ciphertext.length > 24 * 1024) throw new CryptoUnavailableError()
  return ciphertext
}

async function decryptCredential(env: Env, scope: string, stored: string): Promise<unknown> {
  try {
    const response = await vaultRequest(env, '/decrypt', { scope, ciphertext: stored })
    if (response.status === 422) return null
    if (!response.ok) throw new CryptoUnavailableError()
    const body: unknown = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) return null
    return (body as { value: unknown }).value
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    throw new CryptoUnavailableError()
  }
}

async function vaultRequest(env: Env, path: '/encrypt' | '/decrypt', body: unknown): Promise<Response> {
  if (!env.CREDENTIAL_VAULT) throw new CryptoUnavailableError()
  try {
    const id = env.CREDENTIAL_VAULT.idFromName(VAULT_NAME)
    return await env.CREDENTIAL_VAULT.get(id).fetch(`${VAULT_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error
    throw new CryptoUnavailableError()
  }
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

function isBackupCredentialRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set(['password', 'accessKeyId', 'secretAccessKey'])
  const entries = Object.entries(value)
  return entries.length > 0 &&
    entries.length <= allowed.size &&
    entries.every(
      ([key, field]) =>
        allowed.has(key) && typeof field === 'string' && field.length > 0 && field.length <= 4096,
    )
}
