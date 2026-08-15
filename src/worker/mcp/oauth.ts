import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { createMcpHandler } from 'agents/mcp/server'
import { createApp } from '../app'
import { initializeDatabase } from '../db/schema'
import type { Env } from '../env'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { verifyMcpApiKey } from './api-keys'
import { createInkstoneMcpServer, type McpAuthProps } from './server'
import { isMcpEnabled, MCP_SUPPORTED_SCOPES } from './settings'

const app = createApp()

export class InkstoneMcpApi extends WorkerEntrypoint<Env, McpAuthProps> {
  async fetch(request: Request): Promise<Response> {
    const database = await initializeDatabase(this.env)
    if (!await isMcpEnabled(this.env.DB)) {
      return Response.json({ error: 'MCP is disabled in Inkstone settings' }, { status: 403 })
    }
    const auth = this.ctx.props
    if (!isAuthProps(auth)) return Response.json({ error: 'Invalid OAuth grant' }, { status: 401 })
    const user = await this.env.DB.prepare(`SELECT role FROM users WHERE id = ?1`)
      .bind(auth.userId)
      .first<{ role: string }>()
    if (!user) return Response.json({ error: 'Inkstone account no longer exists' }, { status: 401 })

    const requestUrl = new URL(request.url)
    const origin = canonicalOrigin(request, this.env.PUBLIC_URL)
    const canonicalHost = new URL(origin).hostname
    const handler = createMcpHandler(
      () => createInkstoneMcpServer({
        env: this.env,
        auth: { ...auth, role: user.role === 'owner' ? 'owner' : 'member' },
        origin,
        ftsEnabled: database.ftsEnabled,
        executionCtx: this.ctx,
      }),
      {
        route: '/mcp',
        legacy: 'stateless',
        responseMode: 'auto',
        corsOptions: {
          origin,
          headers: 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id',
          exposeHeaders: 'MCP-Protocol-Version, MCP-Session-Id',
        },
        allowedHostnames: [...new Set([requestUrl.hostname, canonicalHost])],
        allowedOriginHostnames: [...new Set([
          requestUrl.hostname,
          canonicalHost,
          'localhost',
          '127.0.0.1',
          '::1',
        ])],
      },
    )
    return handler(request, this.env, this.ctx)
  }
}

export function createOAuthProvider(request: Request, env: Env): OAuthProvider<Env> {
  const origin = canonicalOrigin(request, env.PUBLIC_URL)
  return providerForOrigin(origin, env)
}

export function providerForScheduled(env: Env): OAuthProvider<Env> {
  const origin = configuredOrigin(env.PUBLIC_URL) ?? 'https://inkstone.invalid'
  return providerForOrigin(origin, env)
}

function providerForOrigin(origin: string, env: Env): OAuthProvider<Env> {
  const mcpResource = `${origin}/mcp`
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: InkstoneMcpApi,
    defaultHandler: {
      fetch(request, bindings, ctx) {
        return app.fetch(request, bindings, ctx)
      },
    },
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    clientRegistrationEndpoint: `${origin}/oauth/register`,
    scopesSupported: [...MCP_SUPPORTED_SCOPES],
    resourceMetadata: {
      resource: mcpResource,
      ...(origin.startsWith('https:') ? { authorization_servers: [origin] } : {}),
      scopes_supported: [...MCP_SUPPORTED_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Inkstone private knowledge base',
    },
    clientIdMetadataDocumentEnabled: true,
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    // Static API keys let small or generic MCP clients authenticate with a
    // plain `Authorization: Bearer ink_...` header instead of running the
    // full OAuth 2.1 dance. Keys are hashed and revocable.
    resolveExternalToken: async ({ token, env }) => {
      // This path runs before the API handler, so ensure the schema exists
      // (cheap after the first request thanks to the initialization cache).
      await initializeDatabase(env)
      const auth = await verifyMcpApiKey(env.DB, token)
      if (!auth) return null
      return {
        props: { userId: auth.userId, role: auth.role, scopes: auth.scopes },
        audience: mcpResource,
      }
    },
    clientRegistrationCallback: async ({ request }) => {
      await initializeDatabase(env)
      if (!await isMcpEnabled(env.DB)) {
        return { code: 'access_denied', description: 'MCP is disabled', status: 403 }
      }
      const ip = request.headers.get('CF-Connecting-IP')?.slice(0, 80) || 'unknown'
      try {
        await consumeAttemptBudget(env.DB, [{
          key: `mcp-dcr:${ip}`,
          maxAttempts: 20,
          windowMs: 60 * 60 * 1000,
          lockMs: 60 * 60 * 1000,
        }])
      } catch (error) {
        if (error instanceof ThrottleError) {
          return {
            code: 'temporarily_unavailable',
            description: 'Too many client registrations; try again later',
            status: 429,
          }
        }
        throw error
      }
    },
    onError(error) {
      if (error.internal) {
        console.warn('[inkstone] OAuth error:', error.internal.category, error.internal.reason)
      }
    },
  })
}

function canonicalOrigin(request: Request, value?: string): string {
  return configuredOrigin(value) ?? new URL(request.url).origin
}

function configuredOrigin(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

function isAuthProps(value: unknown): value is McpAuthProps {
  if (!value || typeof value !== 'object') return false
  const props = value as Partial<McpAuthProps>
  return typeof props.userId === 'string' &&
    (props.role === 'owner' || props.role === 'member') &&
    Array.isArray(props.scopes) &&
    props.scopes.every((scope) => typeof scope === 'string')
}
