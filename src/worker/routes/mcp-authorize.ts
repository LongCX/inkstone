import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
} from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { LIMITS } from '@shared/constants'
import type { AppLocale } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { timingSafeEqual } from '../lib/encoding'
import { FORM_BODY_LIMITS, readUrlEncodedFormWithinLimit } from '../lib/request'
import {
  getMcpPreferences,
  grantedMcpScopes,
  isMcpEnabled,
  MCP_SCOPES,
  MCP_SUPPORTED_SCOPES,
} from '../mcp/settings'

const CSRF_COOKIE = 'inkstone_mcp_csrf'
const LOCALE_COOKIE = 'inkstone_mcp_locale'
const LOCALE_QUERY = 'inkstone_lang'

export const mcpAuthorizeRoutes = new Hono<AppBindings>()

mcpAuthorizeRoutes.get('/authorize', async (c) => {
  const localeRedirect = applyLocalePreference(c)
  if (localeRedirect) return localeRedirect
  const locale = authorizationLocale(c)
  const parsed = await parseAuthorization(c.req.raw, c.env.OAUTH_PROVIDER)
  if (parsed instanceof Response) return parsed
  const copy = authorizationCopy(locale)
  if (!await isMcpEnabled(c.env.DB)) {
    return html(c, errorPage(copy.mcpDisabled, locale, c.req.url), 403)
  }
  const client = await c.env.OAUTH_PROVIDER!.lookupClient(parsed.clientId)
  if (!client) return html(c, errorPage(copy.unknownClient, locale, c.req.url), 400)
  const csrf = randomToken()
  setCookie(c, CSRF_COOKIE, csrf, {
    path: '/authorize',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: 10 * 60,
  })
  c.header('Cache-Control', 'no-store')
  const user = c.get('user')
  return html(c, user
    ? consentPage({
        client,
        request: parsed,
        csrf,
        userName: user.name || user.login,
        action: new URL(c.req.url).pathname + new URL(c.req.url).search,
        locale,
        currentUrl: c.req.url,
      })
    : loginPage(client.clientName || 'MCP client', locale, c.req.url), 200)
})

mcpAuthorizeRoutes.post('/authorize', async (c) => {
  assertSameOrigin(c.req.raw)
  const locale = authorizationLocale(c)
  const copy = authorizationCopy(locale)
  const user = c.get('user')
  if (!user) return html(c, errorPage(copy.sessionExpired, locale, c.req.url), 401)
  if (!await isMcpEnabled(c.env.DB)) {
    return html(c, errorPage(copy.mcpDisabled, locale, c.req.url), 403)
  }
  const parsed = await parseAuthorization(c.req.raw, c.env.OAUTH_PROVIDER)
  if (parsed instanceof Response) return parsed
  const body = await readUrlEncodedFormWithinLimit(c.req, FORM_BODY_LIMITS.authorization)
  const submittedCsrf = body.get('csrf') ?? ''
  const storedCsrf = getCookie(c, CSRF_COOKIE) ?? ''
  if (!submittedCsrf || !storedCsrf || !timingSafeEqual(submittedCsrf, storedCsrf)) {
    throw ApiError.forbidden('Authorization form expired. Start the connection again.')
  }
  setCookie(c, CSRF_COOKIE, '', { path: '/authorize', maxAge: 0 })

  if (body.get('decision') !== 'approve') {
    return Response.redirect(
      oauthErrorRedirect(
        parsed,
        'access_denied',
        'The user declined access',
        authorizationIssuer(c.req.raw, parsed),
      ),
      302,
    )
  }
  const client = await c.env.OAUTH_PROVIDER!.lookupClient(parsed.clientId)
  if (!client) return html(c, errorPage(copy.unknownClient, locale, c.req.url), 400)
  const selected = body.getAll('scope').filter((scope) =>
    (MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope),
  )
  const preferences = await getMcpPreferences(c.env.DB, user.id)
  const scopes = grantedMcpScopes(selected.length ? selected : parsed.scope, preferences)
  const { redirectTo } = await c.env.OAUTH_PROVIDER!.completeAuthorization({
    request: parsed,
    userId: user.id,
    scope: scopes,
    metadata: {
      clientName: client.clientName || 'MCP client',
      clientUri: client.clientUri || null,
    },
    props: {
      userId: user.id,
      role: user.role,
      scopes,
    },
  })
  return Response.redirect(
    authorizationResponseRedirect(redirectTo, authorizationIssuer(c.req.raw, parsed)),
    302,
  )
})

async function parseAuthorization(
  request: Request,
  oauth = undefined as AppBindings['Bindings']['OAUTH_PROVIDER'],
): Promise<AuthRequest | Response> {
  if (!oauth) return new Response('OAuth is unavailable', { status: 503 })
  try {
    const parsed = await oauth.parseAuthRequest(request)
    const unsupported = parsed.scope.filter(
      (scope) => scope !== 'offline_access' && !(MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope),
    )
    if (unsupported.length) {
      return Response.redirect(
        oauthErrorRedirect(
          parsed,
          'invalid_scope',
          `Unsupported scope: ${unsupported.join(' ')}`,
          authorizationIssuer(request, parsed),
        ),
        302,
      )
    }
    return parsed
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error
    if (!error.redirectUri) return new Response(error.description, { status: 400 })
    const redirect = new URL(error.redirectUri)
    redirect.searchParams.set('error', error.code)
    redirect.searchParams.set('error_description', error.description)
    if (error.state) redirect.searchParams.set('state', error.state)
    redirect.searchParams.set('iss', error.issuer ?? new URL(request.url).origin)
    return Response.redirect(redirect.toString(), 302)
  }
}

function authorizationIssuer(request: Request, parsed: AuthRequest): string {
  return parsed.issuer ?? new URL(request.url).origin
}

function authorizationResponseRedirect(redirectTo: string, issuer: string): string {
  const redirect = new URL(redirectTo)
  const returnedIssuer = redirect.searchParams.get('iss')
  if (returnedIssuer && returnedIssuer !== issuer) {
    throw new Error('OAuth provider returned a mismatched authorization issuer')
  }
  redirect.searchParams.set('iss', issuer)
  return redirect.toString()
}

function oauthErrorRedirect(
  request: AuthRequest,
  code: string,
  description: string,
  issuer: string,
): string {
  const redirect = new URL(request.redirectUri)
  redirect.searchParams.set('error', code)
  redirect.searchParams.set('error_description', description)
  if (request.state) redirect.searchParams.set('state', request.state)
  redirect.searchParams.set('iss', issuer)
  return redirect.toString()
}

function consentPage(input: {
  client: ClientInfo
  request: AuthRequest
  csrf: string
  userName: string
  action: string
  locale: AppLocale
  currentUrl: string
}): string {
  const requested = new Set(input.request.scope.length ? input.request.scope : [MCP_SCOPES.read])
  const wantsWrite = requested.has(MCP_SCOPES.write)
  const wantsTrash = requested.has(MCP_SCOPES.trash)
  const copy = authorizationCopy(input.locale)
  const clientName = escapeHtml(input.client.clientName || copy.mcpClient)
  return page(`
    <div class="panel-body">
      <section class="request-card">
        <span class="brand-mark">${logoMark()}</span>
        <div class="request-copy">
          <div class="title-line">
            <h1>${copy.accessTitle(clientName)}</h1>
            <span class="badge">OAuth</span>
          </div>
          <p>${copy.signedInAs}<strong class="account">${escapeHtml(input.userName)}</strong>${copy.accountOnly}</p>
        </div>
      </section>
      <form method="post" action="${escapeHtml(input.action)}">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
        <section class="form-section" aria-labelledby="permissions-title">
          <h2 id="permissions-title">${copy.permissions}</h2>
          <div class="settings-list">
            <label class="setting-row fixed">
              <span class="setting-copy"><strong>${copy.readTitle}</strong><small>${copy.readDetail}</small></span>
              <input class="switch" type="checkbox" checked disabled aria-label="${copy.readRequiredAria}">
            </label>
            <input type="hidden" name="scope" value="${MCP_SCOPES.read}">
            ${wantsWrite ? permission(MCP_SCOPES.write, copy.writeTitle, copy.writeDetail, true) : ''}
            ${wantsTrash ? permission(MCP_SCOPES.trash, copy.trashTitle, copy.trashDetail, false) : ''}
          </div>
        </section>
        <section class="form-section" aria-labelledby="privacy-title">
          <h2 id="privacy-title">${copy.privacy}</h2>
          <div class="privacy-row">
            <span class="privacy-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"></path><path d="m9 12 2 2 4-4"></path></svg></span>
            <p>${copy.privacyDetail(clientName)}</p>
          </div>
        </section>
        <div class="actions">
          <button class="secondary" name="decision" value="deny">${copy.cancel}</button>
          <button class="primary" name="decision" value="approve">${copy.allowAccess}</button>
        </div>
      </form>
    </div>`, input.locale, input.currentUrl)
}

function permission(scope: string, title: string, detail: string, checked: boolean): string {
  return `<label class="setting-row"><span class="setting-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><input class="switch" type="checkbox" name="scope" value="${escapeHtml(scope)}" aria-label="${escapeHtml(title)}" ${checked ? 'checked' : ''}></label>`
}

function loginPage(clientName: string, locale: AppLocale, currentUrl: string): string {
  const copy = authorizationCopy(locale)
  return page(`
    <div class="panel-body">
      <section class="request-card">
        <span class="brand-mark">${logoMark()}</span>
        <div class="request-copy">
          <h1>${copy.signInTitle(escapeHtml(clientName))}</h1>
          <p>${copy.passwordOnly}</p>
        </div>
      </section>
      <form id="login" class="login-form">
        <section class="form-section" aria-labelledby="account-title">
          <h2 id="account-title">${copy.inkstoneAccount}</h2>
          <label class="field"><span>${copy.username}</span><input name="username" autocomplete="username" maxlength="32" required autofocus></label>
          <label class="field"><span>${copy.password}</span><input name="password" type="password" autocomplete="current-password" maxlength="${LIMITS.passwordMaxLength}" required></label>
        </section>
        <p id="error" class="error" role="alert"></p>
        <button class="primary wide" type="submit">${copy.signInContinue}</button>
      </form>
      <p class="foot">${copy.needAccount}</p>
    </div>
    <script>
      document.getElementById('login').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const button = event.currentTarget.querySelector('button');
        const error = document.getElementById('error');
        button.disabled = true; error.textContent = '';
        try {
          const response = await fetch('/api/auth/login', {
            method: 'POST', credentials: 'same-origin',
            headers: {'Content-Type':'application/json','X-Inkstone-Client':'1'},
            body: JSON.stringify({username: form.get('username'), password: form.get('password')})
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error?.message || ${JSON.stringify(copy.signInFailed)});
          }
          location.reload();
        } catch (reason) { error.textContent = reason.message || ${JSON.stringify(copy.signInFailed)}; button.disabled = false; }
      });
    </script>`, locale, currentUrl)
}

function errorPage(message: string, locale: AppLocale, currentUrl: string): string {
  const copy = authorizationCopy(locale)
  return page(`
    <div class="panel-body">
      <section class="request-card">
        <span class="brand-mark">${logoMark()}</span>
        <div class="request-copy"><h1>${copy.authorizationFailed}</h1><p>${escapeHtml(message)}</p></div>
      </section>
      <div class="actions"><a class="primary link" href="/">${copy.openInkstone}</a></div>
    </div>`, locale, currentUrl)
}

function authorizationCopy(locale: AppLocale) {
  if (locale === 'zh-CN') {
    return {
      header: 'MCP',
      authorization: '授权',
      switchLabel: 'EN',
      switchAria: '切换为英文',
      mcpClient: 'MCP 客户端',
      accessTitle: (clientName: string) => `${clientName} 请求访问`,
      signedInAs: '已登录为 ',
      accountOnly: '。仅可访问此账户的笔记。',
      permissions: '权限',
      readTitle: '读取与搜索笔记',
      readDetail: '必需。连接的 AI 客户端只会收到工具选中的笔记内容。',
      readRequiredAria: '读取与搜索笔记为必需权限',
      writeTitle: '\u4fee\u6539\u7b14\u8bb0\u5e93',
      writeDetail: '\u53ef\u4fee\u6539\u7b14\u8bb0\u3001\u76ee\u5f55\u3001\u6807\u7b7e\u3001\u5c5e\u6027\u548c\u9644\u4ef6\uff0c\u4e5f\u53ef\u6309\u660e\u786e\u8bf7\u6c42\u521b\u5efa\u5171\u4eab\u94fe\u63a5\u6216\u8fd0\u884c\u5df2\u914d\u7f6e\u7684\u5907\u4efd\uff1b\u5199\u5165\u5305\u542b\u51b2\u7a81\u4fdd\u62a4\u548c\u5e42\u7b49\u952e\u3002',
      trashTitle: '移入回收站',
      trashDetail: '仅软删除；MCP 不提供永久清除功能。',
      privacy: '隐私',
      privacyDetail: (clientName: string) =>
        `Cloudflare 托管静态加密的服务数据。只有工具读取笔记时，内容才会发送给 ${clientName}，之后由该客户端的隐私政策约束。`,
      cancel: '取消',
      allowAccess: '允许访问',
      signInTitle: (clientName: string) => `登录以授权 ${clientName}`,
      passwordOnly: '密码只会发送到当前 Inkstone 部署。',
      inkstoneAccount: 'Inkstone 账户',
      username: '用户名',
      password: '密码',
      signInContinue: '登录并继续',
      needAccount: '还没有账户？请先在另一个标签页打开 Inkstone。',
      signInFailed: '登录失败',
      authorizationFailed: '授权失败',
      openInkstone: '打开 Inkstone',
      mcpDisabled: 'MCP 已在 Inkstone 设置中停用。',
      unknownClient: '未知的 OAuth 客户端。',
      sessionExpired: 'Inkstone 会话已过期，请登录后重试。',
    }
  }
  return {
    header: 'MCP',
    authorization: 'Authorization',
    switchLabel: '中文',
    switchAria: 'Switch to Chinese',
    mcpClient: 'MCP client',
    accessTitle: (clientName: string) => `${clientName} wants access`,
    signedInAs: 'Signed in as ',
    accountOnly: '. Only this account’s notes are available.',
    permissions: 'Permissions',
    readTitle: 'Read and search notes',
    readDetail: 'Required. Selected note text is returned to the connected AI client.',
    readRequiredAria: 'Read and search notes is required',
    writeTitle: 'Modify the note library',
    writeDetail: 'May modify notes, folders, tags, properties, and attachments, and may create shares or run configured backups when explicitly requested. Writes use conflict protection and idempotency keys.',
    trashTitle: 'Move notes to trash',
    trashDetail: 'Soft-delete only. Permanent purge is not exposed through MCP.',
    privacy: 'Privacy',
    privacyDetail: (clientName: string) =>
      `Cloudflare hosts the encrypted-at-rest service data. Note content is sent to ${clientName} only when a tool reads it, then follows that client’s privacy policy.`,
    cancel: 'Cancel',
    allowAccess: 'Allow access',
    signInTitle: (clientName: string) => `Sign in to authorize ${clientName}`,
    passwordOnly: 'Your password is sent only to this Inkstone deployment.',
    inkstoneAccount: 'Inkstone account',
    username: 'Username',
    password: 'Password',
    signInContinue: 'Sign in and continue',
    needAccount: 'Need an account? Open Inkstone in another tab first.',
    signInFailed: 'Sign-in failed',
    authorizationFailed: 'Authorization failed',
    openInkstone: 'Open Inkstone',
    mcpDisabled: 'MCP is disabled in Inkstone settings.',
    unknownClient: 'Unknown OAuth client.',
    sessionExpired: 'Your Inkstone session expired. Sign in and try again.',
  }
}

function applyLocalePreference(c: Context<AppBindings>): Response | null {
  const url = new URL(c.req.url)
  const requested = url.searchParams.get(LOCALE_QUERY)
  if (requested === null) return null
  url.searchParams.delete(LOCALE_QUERY)
  if (isAppLocale(requested)) {
    setCookie(c, LOCALE_COOKIE, requested, {
      path: '/authorize',
      sameSite: 'Lax',
      secure: url.protocol === 'https:',
      maxAge: 365 * 24 * 60 * 60,
    })
  }
  return c.redirect(url.toString(), 302)
}

function authorizationLocale(c: Context<AppBindings>): AppLocale {
  const stored = getCookie(c, LOCALE_COOKIE)
  if (isAppLocale(stored)) return stored
  const user = c.get('user')
  if (user) {
    try {
      const settings = JSON.parse(user.settingsRaw) as { appearance?: { language?: unknown } }
      if (isAppLocale(settings.appearance?.language)) return settings.appearance.language
    } catch {
    }
  }
  return c.req.header('Accept-Language')?.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
}

function isAppLocale(value: unknown): value is AppLocale {
  return value === 'zh-CN' || value === 'en-US'
}

function languageSwitchUrl(currentUrl: string, locale: AppLocale): string {
  const url = new URL(currentUrl)
  url.searchParams.set(LOCALE_QUERY, locale === 'zh-CN' ? 'en-US' : 'zh-CN')
  return url.pathname + url.search
}

function logoMark(): string {
  return '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="2.5" y="2.5" width="27" height="27" rx="8.5"></rect><path d="M16 8.2c2.7 3.5 5.4 6.3 5.4 9.3a5.4 5.4 0 1 1-10.8 0c0-3 2.7-5.8 5.4-9.3z"></path></svg>'
}

function page(content: string, locale: AppLocale, currentUrl: string): string {
  const copy = authorizationCopy(locale)
  const nextLocale = locale === 'zh-CN' ? 'en-US' : 'zh-CN'
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inkstone · ${escapeHtml(copy.authorization)}</title><style>
    :root{color-scheme:light;--bg-sunken:#f1efe9;--bg-base:#f7f5f1;--bg-overlay:#fff;--bg-inset:oklch(96.8% .005 90);--bg-hover:oklch(20% .01 265/4%);--border-subtle:oklch(20% .01 265/7%);--border-default:oklch(20% .01 265/11%);--border-strong:oklch(20% .01 265/17%);--text-primary:oklch(21% .01 265);--text-secondary:oklch(44% .01 265);--text-tertiary:oklch(58% .009 265);--text-quaternary:oklch(70% .007 265);--accent:oklch(54% .15 30);--accent-hover:oklch(48.5% .155 30);--accent-contrast:oklch(99% 0 0);--accent-soft:color-mix(in oklab,var(--accent) 14%,transparent);--accent-ring:color-mix(in oklab,var(--accent) 34%,transparent);--brand-accent:#bb4430;--danger:oklch(64% .19 22);--shadow-modal:0 0 0 1px oklch(20% .01 265/7%),0 8px 16px -4px oklch(20% .01 265/8%),0 24px 48px -12px oklch(20% .01 265/16%)}
    *{box-sizing:border-box}html{min-height:100%;background:var(--bg-sunken)}body{min-height:100vh;min-height:100dvh;margin:0;display:grid;place-items:center;padding:24px;background:var(--bg-sunken);color:var(--text-primary);font-family:'Inter Variable',-apple-system,BlinkMacSystemFont,'Segoe UI Variable Text','Segoe UI',Inter,Roboto,'PingFang SC','Microsoft YaHei UI',sans-serif;-webkit-font-smoothing:antialiased}.panel{width:min(100%,560px);overflow:hidden;border:1px solid var(--border-default);border-radius:20px;background:var(--bg-overlay);box-shadow:var(--shadow-modal)}.panel-header{display:flex;height:48px;align-items:center;border-bottom:1px solid var(--border-subtle);padding:0 20px;font-size:14px;font-weight:600;letter-spacing:-.012em}.header-subtitle{margin-left:8px;border-left:1px solid var(--border-default);padding-left:8px;color:var(--text-tertiary);font-size:11.5px;font-weight:400;letter-spacing:0}.panel-body{padding:18px 20px 20px}.request-card{display:flex;align-items:flex-start;gap:12px;border:1px solid var(--border-subtle);border-radius:12px;background:var(--bg-base);padding:14px}.brand-mark{display:grid;width:34px;height:34px;flex:none;place-items:center}.logo{display:block;width:32px;height:32px}.logo rect{fill:var(--text-primary)}.logo path{fill:var(--brand-accent)}.request-copy{min-width:0;flex:1}.title-line{display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:7px}.request-copy h1{margin:0;color:var(--text-primary);font-size:15px;font-weight:600;line-height:1.35;letter-spacing:-.012em;overflow-wrap:anywhere}.request-copy p{margin:4px 0 0;color:var(--text-tertiary);font-size:11.5px;line-height:1.55}.account{color:var(--text-secondary);font-weight:600}.badge{border-radius:999px;background:var(--accent-soft);padding:2px 6px;color:var(--accent);font-size:10px;font-weight:600;line-height:1.4}.form-section{margin-top:20px}.form-section h2{margin:0 0 4px;padding:0 1px;color:var(--text-quaternary);font-size:10.5px;font-weight:600;line-height:1.4;letter-spacing:.055em;text-transform:uppercase}.settings-list{width:100%}.setting-row{display:flex;min-height:58px;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid var(--border-subtle);padding:10px 1px}.setting-row:not(.fixed){cursor:pointer}.setting-copy{min-width:0;flex:1}.setting-copy strong{display:block;color:var(--text-primary);font-size:13px;font-weight:500;line-height:1.4}.setting-copy small{display:block;margin-top:2px;color:var(--text-tertiary);font-size:11.5px;line-height:1.48}.switch{position:relative;width:34px;height:20px;flex:none;appearance:none;border:0;border-radius:999px;background:var(--border-strong);cursor:pointer;transition:background-color 180ms ease}.switch:after{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.16);content:'';transition:transform 180ms ease}.switch:checked{background:var(--accent)}.switch:checked:after{transform:translateX(14px)}.switch:disabled{cursor:not-allowed;opacity:.46}.switch:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.privacy-row{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--border-subtle);border-radius:12px;background:var(--bg-base);padding:12px}.privacy-icon{display:grid;width:26px;height:26px;flex:none;place-items:center;border-radius:8px;background:var(--accent-soft);color:var(--accent)}.privacy-icon svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.privacy-row p{margin:0;color:var(--text-tertiary);font-size:11.5px;line-height:1.55}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}button,.link{display:inline-flex;min-height:32px;align-items:center;justify-content:center;border-radius:8px;padding:0 12px;font-family:inherit;font-size:12.5px;font-weight:500;text-decoration:none;cursor:pointer;transition:background-color 130ms ease,border-color 130ms ease,filter 130ms ease}.primary{border:1px solid transparent;background:var(--accent);color:var(--accent-contrast);box-shadow:0 1px 2px rgba(0,0,0,.14)}.primary:hover{background:var(--accent-hover)}.secondary{border:1px solid var(--border-default);background:transparent;color:var(--text-secondary)}.secondary:hover{border-color:var(--border-strong);background:var(--bg-hover);color:var(--text-primary)}button:focus-visible,.link:focus-visible,.field input:focus-visible{outline:2px solid var(--accent-ring);outline-offset:2px}button:disabled{cursor:wait;opacity:.5}.login-form .form-section{margin-top:18px}.field{display:grid;gap:5px;margin-top:11px;color:var(--text-secondary);font-size:11.5px;font-weight:500}.field input{width:100%;height:36px;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-inset);padding:0 10px;color:var(--text-primary);font-family:inherit;font-size:13px;font-weight:400;outline:none;transition:border-color 130ms ease,box-shadow 130ms ease}.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring)}.error{margin:9px 0 0;color:var(--danger);font-size:11.5px;line-height:1.45}.error:empty{display:none}.wide{width:100%;margin-top:14px}.foot{margin:12px 0 0;text-align:center;color:var(--text-quaternary);font-size:10.5px;line-height:1.5}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg-sunken:#131110;--bg-base:#181614;--bg-overlay:oklch(27% .012 265);--bg-inset:oklch(14% .008 265);--bg-hover:oklch(100% 0 0/4.5%);--border-subtle:oklch(100% 0 0/6%);--border-default:oklch(100% 0 0/10%);--border-strong:oklch(100% 0 0/17%);--text-primary:oklch(93% .004 265);--text-secondary:oklch(72% .008 265);--text-tertiary:oklch(56% .009 265);--text-quaternary:oklch(43% .008 265);--accent:oklch(66.5% .15 32);--accent-hover:oklch(71% .145 32);--brand-accent:#e0664a;--danger:oklch(68% .185 22);--shadow-modal:0 0 0 1px oklch(100% 0 0/8%),0 16px 40px -8px oklch(0% 0 0/65%),0 40px 80px -20px oklch(0% 0 0/55%)}}
    .panel-header{justify-content:space-between;gap:16px}.panel-heading{display:flex;min-width:0;align-items:center}.language-switch{display:inline-flex;height:28px;flex:none;align-items:center;justify-content:center;border:1px solid var(--border-default);border-radius:8px;padding:0 8px;color:var(--text-tertiary);font-size:11.5px;font-weight:500;text-decoration:none;transition:background-color 130ms ease,border-color 130ms ease,color 130ms ease}.language-switch:hover{border-color:var(--border-strong);background:var(--bg-hover);color:var(--text-primary)}.language-switch:focus-visible{outline:2px solid var(--accent-ring);outline-offset:2px}
    @media(max-width:520px){body{padding:12px}.panel{border-radius:16px}.panel-header{padding:0 16px}.panel-body{padding:16px}.setting-row{gap:16px}.actions{padding-bottom:max(0px,env(safe-area-inset-bottom))}}
  </style></head><body><main class="panel"><header class="panel-header"><div class="panel-heading"><span>${escapeHtml(copy.header)}</span><span class="header-subtitle">${escapeHtml(copy.authorization)}</span></div><a class="language-switch" href="${escapeHtml(languageSwitchUrl(currentUrl, locale))}" hreflang="${nextLocale}" aria-label="${escapeHtml(copy.switchAria)}">${escapeHtml(copy.switchLabel)}</a></header>${content}</main></body></html>`
}

function html(c: Context<AppBindings>, body: string, status: 200 | 400 | 401 | 403 | 503): Response {
  return c.html(body, status)
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) throw ApiError.forbidden('Invalid form origin')
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}
