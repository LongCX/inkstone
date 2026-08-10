import { sha256Hex, timingSafeEqual, toBase64Url } from './encoding'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const TOTP_DIGITS = 6
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_SETUP_TTL_MS = 10 * 60 * 1000
export const TOTP_LOGIN_TTL_MS = 5 * 60 * 1000
export const TOTP_RECOVERY_CODE_COUNT = 10

export function generateTotpSecret(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)))
}

export function buildTotpUri(input: {
  secret: string
  issuer: string
  account: string
}): string {
  const issuer = normalizeLabel(input.issuer, 'Inkstone')
  const account = normalizeLabel(input.account, 'account')
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const query = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${query}`
}

export async function matchTotpCode(
  secret: string,
  input: unknown,
  now = Date.now(),
  window = 1,
): Promise<number | null> {
  const code = normalizeTotpCode(input)
  if (!code) return null
  const current = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS)
  const offsets = [0]
  for (let distance = 1; distance <= Math.max(0, Math.min(2, Math.trunc(window))); distance++) {
    offsets.push(-distance, distance)
  }
  for (const offset of offsets) {
    const step = current + offset
    if (step < 0) continue
    if (timingSafeEqual(await totpCodeForStep(secret, step), code)) return step
  }
  return null
}

export async function totpCodeForStep(secret: string, step: number): Promise<string> {
  const keyBytes = decodeBase32(secret)
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(Math.max(0, Math.trunc(step))), false)
  const signed = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, counter as BufferSource),
  )
  const offset = signed[signed.length - 1]! & 0x0f
  const binary = (
    ((signed[offset]! & 0x7f) << 24) |
    ((signed[offset + 1]! & 0xff) << 16) |
    ((signed[offset + 2]! & 0xff) << 8) |
    (signed[offset + 3]! & 0xff)
  ) >>> 0
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

export function normalizeTotpCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const normalized = value.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(normalized) ? normalized : null
}

export function generateRecoveryCodes(count = TOTP_RECOVERY_CODE_COUNT): string[] {
  const capped = Math.max(1, Math.min(20, Math.trunc(count)))
  return Array.from({ length: capped }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    let raw = ''
    for (const byte of bytes) raw += RECOVERY_ALPHABET[byte & 31]
    return raw.match(/.{1,4}/g)!.join('-')
  })
}

export function normalizeRecoveryCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const normalized = value.toUpperCase().replace(/[\s-]/g, '')
  if (normalized.length !== 16) return null
  for (const character of normalized) {
    if (!RECOVERY_ALPHABET.includes(character)) return null
  }
  return normalized
}

export async function hashRecoveryCode(userId: string, code: string): Promise<string> {
  return sha256Hex(`inkstone:totp-recovery:v1:${userId}:${code}`)
}

export function generateOpaqueToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export async function hashOpaqueToken(token: string): Promise<string> {
  return sha256Hex(`inkstone:totp-token:v1:${token}`)
}

function encodeBase32(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function decodeBase32(value: string): Uint8Array {
  const normalized = value.toUpperCase().replace(/=+$/, '')
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('invalid_base32')
  let buffer = 0
  let bits = 0
  const output: number[] = []
  for (const character of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character)
    bits += 5
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    buffer &= (1 << bits) - 1
  }
  return new Uint8Array(output)
}

function normalizeLabel(value: string, fallback: string): string {
  const normalized = value.trim().replace(/:/g, '').replace(/\s+/g, ' ')
  return [...(normalized || fallback)].slice(0, 64).join('')
}
