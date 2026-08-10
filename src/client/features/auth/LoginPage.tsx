import { useRef, useState } from 'react'
import { ArrowLeft, KeyRound, Loader2, TriangleAlert } from 'lucide-react'
import { LIMITS } from '@shared/constants'
import type { TotpLoginChallenge } from '@shared/types'
import { Logo } from '../../components/primitives'
import { Input } from '../../components/form'
import { cn } from '../../lib/cn'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { initialLoginCredentials } from '../../lib/runtime'
import { useSession } from '../../store/session'

export function LoginPage() {
  const initialCredentials = initialLoginCredentials()
  const site = useSession((state) => state.site)
  const authError = useSession((state) => state.authError)
  const passwordLogin = useSession((state) => state.passwordLogin)
  const totpLogin = useSession((state) => state.totpLogin)
  const passwordRegister = useSession((state) => state.passwordRegister)
  const firstRun = Boolean(site && !site.initialized)
  const [mode, setMode] = useState<'login' | 'register'>(firstRun ? 'register' : 'login')
  const [username, setUsername] = useState(initialCredentials.username)
  const [password, setPassword] = useState(initialCredentials.password)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [challenge, setChallenge] = useState<TotpLoginChallenge | null>(null)
  const [verificationCode, setVerificationCode] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const busyRef = useRef(false)
  const registerMode = mode === 'register' || firstRun
  const showModeSwitch = !firstRun && site?.registrationOpen

  const submit = async () => {
    if (busyRef.current) return
    setError(null)
    if (challenge) {
      if (!verificationCode.trim()) {
        setError(recoveryMode ? t('auth.enter_recovery_code') : t('auth.enter_authenticator_code'))
        return
      }
      busyRef.current = true
      setBusy(true)
      try {
        await totpLogin(challenge.challengeToken, verificationCode)
      } catch (caught) {
        busyRef.current = false
        setBusy(false)
        if (caught instanceof ApiError && caught.code === 'two_factor_challenge_expired') {
          setChallenge(null)
          setVerificationCode('')
          setRecoveryMode(false)
        }
        setError(caught instanceof ApiError ? caught.message : t('auth.network_error_try_again'))
      }
      return
    }
    if (!username.trim() || !password) {
      setError(t("auth.enter_a_username_and_password"))
      return
    }
    if (registerMode && password !== confirmation) {
      setError(t("common.the_passwords_do_not_match"))
      return
    }

    busyRef.current = true
    setBusy(true)
    try {
      if (registerMode) await passwordRegister(username.trim(), password)
      else {
        const nextChallenge = await passwordLogin(username.trim(), password)
        if (nextChallenge) {
          setChallenge(nextChallenge)
          setPassword('')
          setConfirmation('')
          setVerificationCode('')
          setRecoveryMode(false)
          busyRef.current = false
          setBusy(false)
        }
      }
    } catch (caught) {
      busyRef.current = false
      setBusy(false)
      setError(caught instanceof ApiError ? caught.message : t("auth.network_error_try_again"))
    }
  }

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-y-auto px-4 pt-[calc(32px+env(safe-area-inset-top))] pb-[calc(24px+env(safe-area-inset-bottom))] md:px-6 md:py-10">
      <Backdrop />

      <div className="anim-rise relative w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center text-center md:mb-8">
          <div
            className={cn(
              'mb-5 flex size-14 items-center justify-center rounded-[18px]',
              'border border-[var(--border-default)] bg-[var(--bg-surface)]',
              'text-[var(--accent)] shadow-[var(--shadow-pop)]',
            )}
          >
            <Logo size={27} />
          </div>
          <h1
            className="text-[30px] font-semibold tracking-[0.01em] text-[var(--text-primary)]"
            style={{ fontFamily: 'var(--font-serif)' }}
          >
            {t("common.product_name")}
          </h1>
          <p className="mt-2.5 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
            {challenge
              ? t('auth.two_step_verification_description')
              : firstRun
              ? t("auth.create_the_owner_account_this_step_appears_only_once")
              : t("auth.between_the_paper_and_ink_the_pen_comes_to_life_an_inkstone_is_used_to_p")}
          </p>
        </div>

        <form
          className="space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {challenge ? (
            <>
              <div className="mb-3 flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]">
                <KeyRound size={14} className="shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 truncate">@{username.trim()}</span>
              </div>
              <Input
                aria-label={recoveryMode ? t('auth.recovery_code') : t('auth.authenticator_code')}
                value={verificationCode}
                maxLength={recoveryMode ? 24 : 8}
                onChange={(event) => setVerificationCode(
                  recoveryMode
                    ? event.target.value.toUpperCase()
                    : event.target.value.replace(/\D/g, '').slice(0, 6),
                )}
                disabled={busy}
                placeholder={recoveryMode ? 'XXXX-XXXX-XXXX-XXXX' : '000000'}
                autoComplete={recoveryMode ? 'off' : 'one-time-code'}
                autoCapitalize={recoveryMode ? 'characters' : 'none'}
                inputMode={recoveryMode ? 'text' : 'numeric'}
                spellCheck={false}
                autoFocus
              />
            </>
          ) : (
            <>
              <Input
                aria-label={t("common.username")}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
                placeholder={t("common.username")}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
              <Input
                aria-label={t("common.password")}
                type="password"
                value={password}
                maxLength={LIMITS.passwordMaxLength}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                placeholder={registerMode ? t("auth.password_minimum_8_characters") : t("common.password")}
                autoComplete={registerMode ? 'new-password' : 'current-password'}
              />
            </>
          )}
          {!challenge && registerMode && (
            <Input
              aria-label={t("auth.confirm_password")}
              type="password"
              value={confirmation}
              maxLength={LIMITS.passwordMaxLength}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
              placeholder={t("auth.confirm_password")}
              autoComplete="new-password"
            />
          )}
          <button
            type="submit"
            disabled={busy}
            className={cn(
              'flex h-11 w-full items-center justify-center gap-2.5 rounded-[var(--r-lg)]',
              'bg-[var(--accent)] text-[13.5px] font-medium text-[var(--accent-contrast)]',
              'transition-[transform,opacity,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'hover:bg-[var(--accent-hover)] active:translate-y-px disabled:opacity-50',
            )}
          >
            {busy && <Loader2 size={16} className="animate-[ink-spin_.7s_linear_infinite]" />}
            {challenge
              ? t('auth.verify_and_sign_in')
              : registerMode
                ? (firstRun ? t("auth.create_owner_account") : t("auth.sign_up"))
                : t("auth.sign_in")}
          </button>
          {challenge && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setChallenge(null)
                  setVerificationCode('')
                  setRecoveryMode(false)
                  setError(null)
                }}
                className="inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
              >
                <ArrowLeft size={12} />
                {t('auth.back_to_password')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRecoveryMode((value) => !value)
                  setVerificationCode('')
                  setError(null)
                }}
                className="text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
              >
                {recoveryMode ? t('auth.use_authenticator_code') : t('auth.use_recovery_code')}
              </button>
            </div>
          )}
          {!challenge && showModeSwitch && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMode(registerMode ? 'login' : 'register')
                setError(null)
              }}
              className="mx-auto block text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
            >
              {registerMode ? t("auth.already_have_an_account_sign_in") : t("auth.no_account_create_one")}
            </button>
          )}
        </form>

        {(error || authError) && (
          <div role="alert" className="anim-rise mt-4 flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--danger)_9%,transparent)] px-3 py-2.5">
            <TriangleAlert size={14} className="mt-[1px] shrink-0 text-[var(--danger)]" />
            <span className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {error || authError}
            </span>
          </div>
        )}

        <div className="mt-6 space-y-2 text-center md:mt-8">
          {site?.initialized && !site.registrationOpen && (
            <p className="text-[11.5px] leading-relaxed text-[var(--text-quaternary)]">
              {t("auth.this_is_a_private_instance_registration_is_closed_so_only_existing_accou")}
            </p>
          )}
          <p className="text-[11px] tracking-[0.04em] text-[var(--text-quaternary)]">
            {t("auth.live_split_view_markdown_preview_realtime_multi_device_sync_multiple_web")}
          </p>
        </div>
      </div>

      <footer className="pointer-events-none mt-6 text-center text-[11px] tracking-[0.05em] text-[var(--text-quaternary)] md:mt-8">
        {t("auth.self_hosted_on_cloudflare_workers_your_data_is_yours")}
      </footer>
    </div>
  )
}


function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-1/2 top-[-22%] size-[720px] -translate-x-1/2 rounded-full opacity-[0.13] blur-[120px]"
        style={{ background: 'var(--accent)' }}
      />
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            'linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px)',
          backgroundSize: '52px 52px',
          maskImage: 'radial-gradient(ellipse 80% 55% at 50% 40%, #000 20%, transparent 78%)',
        }}
      />
    </div>
  )
}
