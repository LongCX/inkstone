import { runAttachmentCleanup } from './attachments/cleanup'
import { runScheduledBackups } from './backup/scheduler'
import type { Env } from './env'
import { initializeDatabase } from './db/schema'
import { drainAllFtsQueues } from './db/fts'
import { drainAiIndexQueue } from './mcp/ai-search'
import { createOAuthProvider, providerForScheduled } from './mcp/oauth'
import { purgeRevokedMcpApiKeys } from './mcp/api-keys'
import { purgeExpiredMcpOperations } from './mcp/operations'
import { purgeExpiredOperationalData } from './lib/maintenance'

export { SyncHub } from './realtime/sync-hub'
export { CredentialVault } from './durable/credential-vault'

// Codex CLI drops the `iss` callback parameter while its rmcp
// dependency enforces it whenever the authorization server advertises
// `authorization_response_iss_parameter_supported` (openai/codex#31573), so
// login fails even though the parameter is on the wire. Serve the metadata
// without that flag to keep codex compatible; the standard RFC 9207 `iss`
// parameter is still appended to callbacks for conforming clients.
const OAUTH_AUTHORIZATION_SERVER_METADATA = '/.well-known/oauth-authorization-server'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const oauthRequest = await normalizeRepeatedOAuthResource(request)
    const provider = createOAuthProvider(oauthRequest, env)
    if (new URL(oauthRequest.url).pathname === OAUTH_AUTHORIZATION_SERVER_METADATA) {
      return oauthMetadataWithoutIssParameter(provider, oauthRequest, env, ctx)
    }
    return provider.fetch(oauthRequest, env, ctx)
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      await initializeDatabase(env)
      await Promise.all([
        runScheduledBackups(env),
        runAttachmentCleanup(env),
        purgeExpiredMcpOperations(env.DB),
        purgeExpiredOperationalData(env.DB),
        purgeRevokedMcpApiKeys(env.DB),
        providerForScheduled(env).purgeExpiredData(env, { batchSize: 100 }),
        drainAiIndexQueue(env, 300),
        drainAllFtsQueues(env.DB),
      ])
    })())
  },
} satisfies ExportedHandler<Env>

async function normalizeRepeatedOAuthResource(request: Request): Promise<Request> {
  const url = new URL(request.url)
  if (url.pathname === '/authorize') {
    const resources = url.searchParams.getAll('resource')
    if (resources.length > 1 && resources.every((resource) => resource === resources[0])) {
      url.searchParams.delete('resource')
      url.searchParams.set('resource', resources[0]!)
      return new Request(url, request)
    }
    return request
  }
  if (url.pathname !== '/oauth/token' || request.method !== 'POST' ||
      !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return request
  }
  const body = await request.clone().text()
  const form = new URLSearchParams(body)
  const resources = form.getAll('resource')
  if (resources.length < 2 || !resources.every((resource) => resource === resources[0])) return request
  form.delete('resource')
  form.set('resource', resources[0]!)
  const headers = new Headers(request.headers)
  headers.delete('Content-Length')
  return new Request(request, { body: form.toString(), headers })
}

async function oauthMetadataWithoutIssParameter(
  provider: ReturnType<typeof createOAuthProvider>,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await provider.fetch(request, env, ctx)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.ok || !contentType.includes('application/json')) return response
  const metadata = (await response.json()) as Record<string, unknown>
  delete metadata.authorization_response_iss_parameter_supported
  const headers = new Headers(response.headers)
  headers.delete('Content-Length')
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
