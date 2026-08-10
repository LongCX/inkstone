import { useEffect, useRef, useState } from 'react'
import { Camera, KeyRound, LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
import { LIMITS } from '@shared/constants'
import { Avatar, Badge, Button } from '../../components/primitives'
import { Input, SettingRow, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { AvatarPicker } from './AvatarPicker'
import { TotpSettings } from './TotpSettings'

export function AccountSettings() {
  const user = useSession((state) => state.user)
  if (!user) return null

  return (
    <div className="space-y-6">
      <ProfileSection />

      <section>
        <h3 className="mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
          {t("settings.sign_in_security")}
        </h3>
        <div className="space-y-2">
          <PasswordSection />
          <TotpSettings />
        </div>
      </section>

      {user.role === 'owner' && (
        <section>
          <h3 className="mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
            {t("common.access_control")}
          </h3>
          <RegistrationSection />
        </section>
      )}
    </div>
  )
}

function ProfileSection() {
  const user = useSession((state) => state.user)!
  const updateProfile = useSession((state) => state.updateProfile)
  const toast = useUi((state) => state.toast)
  const [name, setName] = useState(user.name)
  const [edited, setEdited] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!edited) setName(user.name)
  }, [edited, user.name])

  const normalizedName = name.trim().replace(/\s+/gu, ' ')
  const validName = Boolean(normalizedName) && [...normalizedName].length <= PROFILE_NAME_MAX_LENGTH
  const changed = normalizedName !== user.name

  const saveName = async () => {
    if (busyRef.current) return
    if (!validName) {
      setError(t('settings.display_name_length', { max: PROFILE_NAME_MAX_LENGTH }))
      return
    }
    if (!changed) {
      setEdited(false)
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const updated = await updateProfile({ name: normalizedName })
      setName(updated.name)
      setEdited(false)
      toast({ title: t('settings.display_name_saved'), tone: 'success' })
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('settings.action_failed_try_again'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <section>
      <h3 className="mb-2 px-1 text-[12px] font-semibold text-[var(--text-secondary)]">
        {t('settings.personal_profile')}
      </h3>
      <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
        <div className="flex items-center gap-3 p-4">
          <button
            type="button"
            aria-label={t('settings.change_avatar')}
            onClick={() => setPickerOpen(true)}
            className="group relative shrink-0 rounded-full outline-none ring-offset-2 ring-offset-[var(--bg-base)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <Avatar src={user.avatarUrl} name={user.name} size={52} />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-white opacity-0 transition-[background-color,opacity] group-hover:bg-black/40 group-hover:opacity-100 group-focus-visible:bg-black/40 group-focus-visible:opacity-100">
              <Camera size={16} />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                {user.name}
              </span>
              {user.role === 'owner' && <Badge tone="accent">{t('common.owner')}</Badge>}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
              <UserRound size={11} />@{user.username}
            </div>
            <p className="mt-1 text-[10.5px] text-[var(--text-quaternary)]">
              {t('settings.username_is_sign_in_id')}
            </p>
          </div>
          <LogoutButton />
        </div>

        <form
          className="border-t border-[var(--border-subtle)] px-4 py-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void saveName()
          }}
        >
          <label htmlFor="profile-display-name" className="block text-[11.5px] font-medium text-[var(--text-secondary)]">
            {t('settings.display_name')}
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <Input
              id="profile-display-name"
              value={name}
              maxLength={PROFILE_NAME_MAX_LENGTH * 2}
              onChange={(event) => {
                setName(event.target.value)
                setEdited(true)
                setError(null)
              }}
              disabled={busy}
              autoComplete="name"
              className="flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!edited || !changed || !validName}
            >
              {t('common.save')}
            </Button>
          </div>
          {error && <p role="alert" className="mt-1.5 text-[12px] text-[var(--danger)]">{error}</p>}
        </form>
      </div>

      <AvatarPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        displayName={user.name}
        preference={user.avatarUrl}
      />
    </section>
  )
}

function LogoutButton() {
  const logout = useSession((state) => state.logout)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const run = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const ok = await confirm({
        title: t("common.log_out"),
        description: t("settings.this_device_will_be_signed_out_and_its_local_cache_cleared_cloud_data_is"),
        confirmLabel: t("common.exit"),
      })
      if (ok) await logout()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<LogOut size={13} />}
      loading={busy}
      onClick={() => void run()}
    >
      {t("common.exit")}
    </Button>
  )
}

function PasswordSection() {
  const user = useSession((state) => state.user)!
  const toast = useUi((state) => state.toast)
  const [open, setOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const resetForm = () => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmation('')
    setError(null)
  }

  const submit = async () => {
    if (busyRef.current) return
    setError(null)
    if (!currentPassword) return setError(t("settings.enter_your_current_password"))
    if (newPassword.length < 8) return setError(t("settings.new_password_must_be_at_least_8_characters"))
    if (newPassword !== confirmation) return setError(t("common.the_passwords_do_not_match"))
    busyRef.current = true
    setBusy(true)
    try {
      await api.auth.setPassword({ currentPassword, newPassword })
      toast({
        title: t("settings.password_updated"),
        description: t("settings.other_devices_have_been_logged_out"),
        tone: 'success',
      })
      setOpen(false)
      resetForm()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("settings.action_failed_try_again"))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <SettingRow
        className="px-4"
        title={t("settings.login_password")}
        description={t("settings.username_value0_changing_the_password_signs_out_other_devices", {
          value0: user.username,
        })}
      >
        <Button
          size="sm"
          variant="secondary"
          icon={<KeyRound size={12} />}
          disabled={busy}
          onClick={() => {
            setOpen(!open)
            resetForm()
          }}
        >
          {open ? t("common.collapse") : t("settings.change_password")}
        </Button>
      </SettingRow>

      {open && (
        <form
          className="space-y-2.5 border-t border-[var(--border-subtle)] px-4 py-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
              {t("settings.current_password")}
            </span>
            <Input
              type="password"
              value={currentPassword}
              maxLength={LIMITS.passwordMaxLength}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={busy}
              autoComplete="current-password"
            />
          </label>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
                {t("settings.new_password")}
              </span>
              <Input
                type="password"
                value={newPassword}
                maxLength={LIMITS.passwordMaxLength}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={busy}
                autoComplete="new-password"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">
                {t("settings.confirm_new_password")}
              </span>
              <Input
                type="password"
                value={confirmation}
                maxLength={LIMITS.passwordMaxLength}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={busy}
                autoComplete="new-password"
              />
            </label>
          </div>
          {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" loading={busy}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function RegistrationSection() {
  const site = useSession((state) => state.site)
  const updateRegistration = useSession((state) => state.updateRegistration)
  const toast = useUi((state) => state.toast)
  const [target, setTarget] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const enabled = site?.registrationOpen ?? false
  const confirming = target !== null

  useEffect(() => {
    if (target !== null && target === enabled && !busy) {
      setTarget(null)
      setPassword('')
      setError(null)
    }
  }, [busy, enabled, target])

  const beginToggle = (next: boolean) => {
    if (busyRef.current) return
    setError(null)
    setPassword('')
    setTarget(next)
  }

  const finishToggle = async () => {
    if (busyRef.current || target === null) return
    const requested = target
    setError(null)
    if (!password) return setError(t("settings.enter_your_password"))
    busyRef.current = true
    setBusy(true)
    const currentPassword = password
    setTarget(null)
    setPassword('')
    try {
      await updateRegistration(requested, currentPassword)
      toast({
        title: requested ? t("settings.registration_open") : t("settings.registration_closed"),
        description: requested ? t("settings.anyone_can_now_register_a_new_account") : t("settings.only_existing_accounts_can_log_in"),
        tone: 'success',
      })
    } catch (caught) {
      setTarget(requested)
      setError(caught instanceof ApiError ? caught.message : t("settings.action_failed_try_again"))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <SettingRow
        className="px-4"
        title={t("common.open_registration")}
        description={`${
          enabled
            ? t("settings.open_anyone_can_register_with_a_username_and_password")
            : t("settings.off_default_only_existing_accounts_can_log_in")
        } ${t("settings.changing_this_requires_your_current_password_and_takes_effect_immediatel")}`}
      >
        <Switch
          checked={enabled}
          disabled={busy}
          onChange={beginToggle}
          label={t("common.open_registration")}
        />
      </SettingRow>

      {confirming && (
        <form
          className="space-y-2.5 border-t border-[var(--border-subtle)] px-4 py-3.5"
          onSubmit={(event) => {
            event.preventDefault()
            void finishToggle()
          }}
        >
          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
              <ShieldCheck size={12} />
              {target ? t("settings.open_registration_requires_password_verification") : t("settings.close_registration_requires_password_verification")}
            </span>
            <Input
              type="password"
              value={password}
              maxLength={LIMITS.passwordMaxLength}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setTarget(null)
                setPassword('')
                setError(null)
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={target ? 'danger' : 'primary'}
              loading={busy}
            >
              {target ? t("settings.confirm_opening_registration") : t("settings.confirm_closing_registration")}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
