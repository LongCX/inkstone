import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  KeyRound,
  QrCode,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { LIMITS } from '@shared/constants'
import type { TotpSetupInfo, TotpStatus } from '@shared/types'
import { Button, Badge } from '../../components/primitives'
import { Input, SettingRow } from '../../components/form'
import { api, ApiError } from '../../lib/api'
import { downloadTextFile } from '../../lib/export-note'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

type Panel = 'none' | 'enable' | 'setup' | 'recovery' | 'regenerate' | 'disable'

export function TotpSettings() {
  const toast = useUi((state) => state.toast)
  const [status, setStatus] = useState<TotpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [panel, setPanel] = useState<Panel>('none')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<TotpSetupInfo | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const busyRef = useRef(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await api.auth.totp.status()
      if (mountedRef.current) setStatus(next)
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
    }
  }, [])

  const resetForm = (next: Panel = 'none') => {
    setPanel(next)
    setPassword('')
    setCode('')
    setError(null)
    if (next !== 'setup') setSetup(null)
    if (next !== 'recovery') setRecoveryCodes([])
  }

  const run = async (task: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (caught) {
      if (mountedRef.current) setError(errorMessage(caught))
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  const beginSetup = () => void run(async () => {
    if (!password) {
      setError(t('settings.enter_your_current_password'))
      return
    }
    const next = await api.auth.totp.startSetup(password)
    if (!mountedRef.current) return
    setSetup(next)
    setPassword('')
    setCode('')
    setPanel('setup')
  })

  const confirmSetup = () => void run(async () => {
    if (!setup || code.replace(/\D/g, '').length !== 6) {
      setError(t('settings.totp_enter_six_digit_code'))
      return
    }
    const result = await api.auth.totp.confirmSetup(setup.setupToken, code)
    if (!mountedRef.current) return
    setStatus((current) => ({
      available: current?.available ?? true,
      enabled: true,
      enabledAt: result.enabledAt,
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    }))
    setSetup(null)
    setCode('')
    setRecoveryCodes(result.recoveryCodes)
    setPanel('recovery')
    toast({
      title: t('settings.totp_enabled'),
      description: t('settings.totp_other_sessions_revoked'),
      tone: 'success',
    })
  })

  const cancelSetup = () => void run(async () => {
    const pending = setup
    resetForm()
    if (pending) await api.auth.totp.cancelSetup(pending.setupToken).catch(() => {})
  })

  const regenerate = () => void run(async () => {
    if (!password) {
      setError(t('settings.enter_your_current_password'))
      return
    }
    if (code.replace(/\D/g, '').length !== 6) {
      setError(t('settings.totp_enter_six_digit_code'))
      return
    }
    const result = await api.auth.totp.regenerateRecoveryCodes(password, code)
    if (!mountedRef.current) return
    setStatus((current) => current && ({
      ...current,
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    }))
    setPassword('')
    setCode('')
    setRecoveryCodes(result.recoveryCodes)
    setPanel('recovery')
    toast({ title: t('settings.totp_recovery_codes_replaced'), tone: 'success' })
  })

  const disable = () => void run(async () => {
    if (!password) {
      setError(t('settings.enter_your_current_password'))
      return
    }
    if (!code.trim()) {
      setError(t('settings.totp_enter_code_or_recovery'))
      return
    }
    await api.auth.totp.disable(password, code)
    if (!mountedRef.current) return
    setStatus((current) => ({
      available: current?.available ?? true,
      enabled: false,
      enabledAt: null,
      recoveryCodesRemaining: 0,
    }))
    resetForm()
    toast({
      title: t('settings.totp_disabled'),
      description: t('settings.totp_other_sessions_revoked'),
      tone: 'success',
    })
  })

  const copy = async (value: string, message: string) => {
    try {
      await copyText(value)
      toast({ title: message, tone: 'success' })
    } catch {
      setError(t('settings.totp_copy_failed'))
    }
  }

  const downloadRecoveryCodes = () => {
    const content = [
      t('settings.totp_recovery_file_title'),
      t('settings.totp_recovery_file_warning'),
      '',
      ...recoveryCodes,
      '',
    ].join('\n')
    downloadTextFile('inkstone-recovery-codes.txt', content, 'text/plain;charset=utf-8')
  }

  if (loading && !status) {
    return (
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-4 text-[12px] text-[var(--text-tertiary)]">
        {t('settings.totp_loading')}
      </div>
    )
  }

  if (!status) {
    return (
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {error ?? t('settings.totp_load_failed')}
        </p>
        <Button className="mt-3" size="sm" icon={<RefreshCw size={12} />} onClick={() => void load()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <SettingRow
        className="px-4"
        title={t('settings.totp_title')}
        description={status.enabled
          ? t('settings.totp_enabled_description', { count: status.recoveryCodesRemaining })
          : status.available
            ? t('settings.totp_disabled_description')
            : t('settings.totp_unavailable_description')}
      >
        <div className="flex items-center gap-2">
          <Badge tone={status.enabled ? 'accent' : 'neutral'}>
            {status.enabled ? t('common.on') : t('common.off')}
          </Badge>
          {panel === 'none' && (
            status.enabled ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<KeyRound size={12} />}
                onClick={() => resetForm('regenerate')}
              >
                {t('settings.totp_manage')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={<ShieldCheck size={12} />}
                disabled={!status.available}
                onClick={() => resetForm('enable')}
              >
                {t('settings.totp_enable')}
              </Button>
            )
          )}
        </div>
      </SettingRow>

      {panel === 'enable' && (
        <form className="space-y-3 border-t border-[var(--border-subtle)] px-4 py-4" onSubmit={(event) => {
          event.preventDefault()
          beginSetup()
        }}>
          <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            {t('settings.totp_enable_password_description')}
          </p>
          <PasswordInput value={password} busy={busy} onChange={setPassword} autoFocus />
          <InlineError error={error} />
          <ActionRow busy={busy} onCancel={() => resetForm()} submitLabel={t('common.continue')} />
        </form>
      )}

      {panel === 'setup' && setup && (
        <form className="space-y-4 border-t border-[var(--border-subtle)] px-4 py-4" onSubmit={(event) => {
          event.preventDefault()
          confirmSetup()
        }}>
          <div className="grid gap-4 md:grid-cols-[210px_minmax(0,1fr)] md:items-start">
            <div className="mx-auto rounded-[16px] border border-[var(--border-default)] bg-white p-2 shadow-[var(--shadow-soft)]">
              <QRCodeSVG
                value={setup.uri}
                size={190}
                level="M"
                marginSize={1}
                bgColor="#ffffff"
                fgColor="#111827"
                title={t('settings.totp_qr_code_title')}
              />
            </div>
            <div className="min-w-0 space-y-3">
              <div>
                <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                  <QrCode size={15} className="text-[var(--accent)]" />
                  {t('settings.totp_scan_qr')}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
                  {t('settings.totp_scan_qr_description')}
                </p>
              </div>
              <div className="rounded-[var(--r-md)] bg-[var(--bg-surface)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-[var(--text-tertiary)]">
                    {t('settings.totp_manual_secret')}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    icon={<Copy size={11} />}
                    onClick={() => void copy(setup.secret, t('settings.totp_secret_copied'))}
                  >
                    {t('common.copy')}
                  </Button>
                </div>
                <code className="mt-1.5 block break-all font-mono text-[12px] tracking-[0.08em] text-[var(--text-primary)]">
                  {setup.secret.match(/.{1,4}/g)?.join(' ')}
                </code>
              </div>
              <label className="block">
                <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
                  {t('settings.totp_confirm_code')}
                </span>
                <Input
                  value={code}
                  maxLength={6}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={busy}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                />
              </label>
            </div>
          </div>
          <InlineError error={error} />
          <ActionRow busy={busy} onCancel={cancelSetup} submitLabel={t('settings.totp_confirm_enable')} />
        </form>
      )}

      {panel === 'recovery' && recoveryCodes.length > 0 && (
        <div className="space-y-4 border-t border-[var(--border-subtle)] px-4 py-4">
          <div className="flex items-start gap-2.5 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] p-3">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-[var(--warning)]" />
            <div>
              <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {t('settings.totp_save_recovery_codes')}
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
                {t('settings.totp_recovery_codes_once')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {recoveryCodes.map((recoveryCode, index) => (
              <code
                key={recoveryCode}
                className="select-all rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-center font-mono text-[12px] tracking-[0.04em] text-[var(--text-primary)]"
              >
                <span className="mr-2 text-[var(--text-quaternary)]">{index + 1}.</span>
                {recoveryCode}
              </code>
            ))}
          </div>
          <InlineError error={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy size={12} />}
              onClick={() => void copy(recoveryCodes.join('\n'), t('settings.totp_recovery_codes_copied'))}
            >
              {t('settings.totp_copy_all')}
            </Button>
            <Button size="sm" variant="secondary" icon={<Download size={12} />} onClick={downloadRecoveryCodes}>
              {t('common.download')}
            </Button>
            <Button size="sm" variant="primary" icon={<Check size={12} />} onClick={() => resetForm()}>
              {t('settings.totp_saved_codes')}
            </Button>
          </div>
        </div>
      )}

      {panel === 'regenerate' && (
        <form className="space-y-3 border-t border-[var(--border-subtle)] px-4 py-4" onSubmit={(event) => {
          event.preventDefault()
          regenerate()
        }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {t('settings.totp_recovery_codes')}
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
                {t('settings.totp_regenerate_description')}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="danger"
              icon={<ShieldOff size={12} />}
              disabled={busy}
              onClick={() => resetForm('disable')}
            >
              {t('settings.totp_disable')}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <PasswordInput value={password} busy={busy} onChange={setPassword} autoFocus />
            <CodeInput value={code} busy={busy} onChange={setCode} />
          </div>
          <InlineError error={error} />
          <ActionRow busy={busy} onCancel={() => resetForm()} submitLabel={t('settings.totp_generate_new_codes')} />
        </form>
      )}

      {panel === 'disable' && (
        <form className="space-y-3 border-t border-[var(--border-subtle)] px-4 py-4" onSubmit={(event) => {
          event.preventDefault()
          disable()
        }}>
          <div className="flex items-start gap-2.5 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)] p-3">
            <ShieldOff size={15} className="mt-0.5 shrink-0 text-[var(--danger)]" />
            <div>
              <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {t('settings.totp_disable_title')}
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
                {t('settings.totp_disable_description')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <PasswordInput value={password} busy={busy} onChange={setPassword} autoFocus />
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
                {t('settings.totp_code_or_recovery')}
              </span>
              <Input
                value={code}
                maxLength={24}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                disabled={busy}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder={t('settings.totp_code_or_recovery_placeholder')}
              />
            </label>
          </div>
          <InlineError error={error} />
          <ActionRow
            busy={busy}
            onCancel={() => resetForm('regenerate')}
            submitLabel={t('settings.totp_confirm_disable')}
            danger
          />
        </form>
      )}
    </div>
  )
}

function PasswordInput(props: {
  value: string
  busy: boolean
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
        {t('settings.current_password')}
      </span>
      <Input
        type="password"
        value={props.value}
        maxLength={LIMITS.passwordMaxLength}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.busy}
        autoComplete="current-password"
        autoFocus={props.autoFocus}
      />
    </label>
  )
}

function CodeInput(props: { value: string; busy: boolean; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
        {t('settings.totp_authenticator_code')}
      </span>
      <Input
        value={props.value}
        maxLength={6}
        onChange={(event) => props.onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        disabled={props.busy}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
      />
    </label>
  )
}

function ActionRow(props: {
  busy: boolean
  onCancel: () => void
  submitLabel: string
  danger?: boolean
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
        {t('common.cancel')}
      </Button>
      <Button
        type="submit"
        size="sm"
        variant={props.danger ? 'danger' : 'primary'}
        loading={props.busy}
      >
        {props.submitLabel}
      </Button>
    </div>
  )
}

function InlineError(props: { error: string | null; className?: string }) {
  if (!props.error) return null
  return <p role="alert" className={`text-[12px] text-[var(--danger)] ${props.className ?? ''}`}>{props.error}</p>
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : t('settings.action_failed_try_again')
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const field = document.createElement('textarea')
  field.value = value
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy_failed')
  } finally {
    field.remove()
  }
}
