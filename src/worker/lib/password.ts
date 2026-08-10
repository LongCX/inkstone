import { scrypt as nodeScrypt } from 'node:crypto'
import { LIMITS } from '@shared/constants'
import { fromBase64Url, timingSafeEqual, toBase64Url } from './encoding'


const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = LIMITS.passwordMaxLength
export const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/
export const SCRYPT_N = 2 ** 14
export const SCRYPT_R = 8
export const SCRYPT_P = 5

const SCRYPT_KEY_BYTES = 32
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024
const HASH_PATTERN = /^scrypt\$16384\$8\$5\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/
const DUMMY_HASH =
  'scrypt$16384$8$5$ABEiM0RVZneImaq7zN3u_w$EzsVp6WklW-qw8-htpRdJyzAeyRHPzojfjgoy1qFiRw'

interface ParsedPasswordHash {
  salt: Uint8Array
  expected: string
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must contain at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (password.length > PASSWORD_MAX_LENGTH) return 'Password is too long'
  return null
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length > PASSWORD_MAX_LENGTH) throw new Error('password_too_long')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await deriveScrypt(password, salt)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${toBase64Url(salt)}$${toBase64Url(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false
  const parsed = parsePasswordHash(stored)
  if (!parsed) return false
  try {
    const actual = await deriveScrypt(password, parsed.salt)
    return timingSafeEqual(toBase64Url(actual), parsed.expected)
  } catch {
    return false
  }
}

export function isPasswordHash(stored: string): boolean {
  return parsePasswordHash(stored) !== null
}

export async function dummyVerify(): Promise<void> {
  await verifyPassword('definitely-not-the-password', DUMMY_HASH)
}

function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  if (stored.length > 160) return null
  const match = HASH_PATTERN.exec(stored)
  if (!match) return null
  try {
    const salt = fromBase64Url(match[1]!)
    const expectedBytes = fromBase64Url(match[2]!)
    if (salt.byteLength !== 16 || expectedBytes.byteLength !== SCRYPT_KEY_BYTES) return null
    return { salt, expected: match[2]! }
  } catch {
    return null
  }
}

function deriveScrypt(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
      (error, derived) => {
        if (error) reject(error)
        else resolve(derived)
      },
    )
  })
}
