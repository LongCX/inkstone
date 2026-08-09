import { useRef, useState } from 'react';
import { Download, ExternalLink, GitFork, LogOut, RefreshCw, Shield, UserRound } from 'lucide-react';
import { GITHUB_REPOSITORY_URL } from '@shared/constants';
import { fullTime } from '../../lib/time';
import { Avatar, Badge, Button, Logo } from '../../components/primitives';
import { SettingRow } from '../../components/form';
import { confirm } from '../../components/overlay';
import { useSession } from '../../store/session';
import { usePwa } from '../../store/pwa';
import { useUpdate } from '../../store/update';
import { t } from "../../lib/i18n";
export function AboutSettings() {
    const user = useSession((s) => s.user);
    const site = useSession((s) => s.site);
    const logout = useSession((s) => s.logout);
    const updateStatus = useUpdate((s) => s.status);
    const updateInfo = useUpdate((s) => s.info);
    const updateAvailable = useUpdate((s) => s.available);
    const checkForUpdates = useUpdate((s) => s.check);
    const openUpdatePage = useUpdate((s) => s.openUpdatePage);
    const installAvailable = usePwa((s) => s.installAvailable);
    const installed = usePwa((s) => s.installed);
    const installing = usePwa((s) => s.installing);
    const install = usePwa((s) => s.install);
    const offlineStatus = usePwa((s) => s.offlineStatus);
    const offlineCompleted = usePwa((s) => s.offlineCompleted);
    const offlineTotal = usePwa((s) => s.offlineTotal);
    const loggingOutRef = useRef(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const exit = async () => {
        if (loggingOutRef.current)
            return;
        loggingOutRef.current = true;
        setLoggingOut(true);
        try {
            const ok = await confirm({
                title: t("common.log_out"),
                description: t("settings.the_local_cache_will_be_cleared_and_the_cloud_data_will_not_be_affected"),
                confirmLabel: t("common.exit"),
            });
            if (ok)
                await logout();
        }
        finally {
            loggingOutRef.current = false;
            setLoggingOut(false);
        }
    };
    return (<div className="space-y-6">
      <section>
        <div className="flex items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
          <Avatar src={user?.avatarUrl} name={user?.name ?? '?'} size={44}/>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                {user?.name}
              </span>
              {user?.role === 'owner' && <Badge tone="accent">{t("common.owner")}</Badge>}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
              <UserRound size={11}/>@{user?.username}
            </div>
          </div>
          <Button size="sm" variant="ghost" icon={<LogOut size={13}/>} loading={loggingOut} disabled={loggingOut} onClick={() => void exit()}>{t("common.exit")}</Button>
        </div>
        {user && (<p className="mt-2 px-1 text-[11.5px] text-[var(--text-quaternary)]">{t("settings.joined")}{fullTime(user.createdAt)}
          </p>)}
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("common.access_control")}</h3>

        <SettingRow title={t("settings.registration_status")} description={site?.registrationOpen
            ? t("settings.new_accounts_can_currently_register_with_a_username_and_password") : t("settings.only_existing_accounts_can_sign_in_new_accounts_are_rejected")}>
          <Badge tone={site?.registrationOpen ? 'warning' : 'success'}>
            {site?.registrationOpen ? t("common.open_registration") : t("settings.private_instance")}
          </Badge>
        </SettingRow>

        <div className="mt-3 flex items-start gap-2.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
          <Shield size={14} className="mt-px shrink-0 text-[var(--text-tertiary)]"/>
          <div className="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{t("settings.to_add_users_open_registration_under_settings_account_they_can_then_crea")}</div>
        </div>
      </section>

      {user?.role === 'owner' && (<section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.deployment_updates")}</h3>
        <SettingRow title={t("settings.current_version")}>
          <Badge>{updateInfo?.currentVersion ?? site?.version ?? '—'}</Badge>
        </SettingRow>
        <SettingRow title={t("settings.latest_version")} description={updateInfo?.checkedAt
            ? `${t("settings.checked_at")} ${fullTime(updateInfo.checkedAt)}` : undefined}>
          <Badge tone={updateAvailable ? 'warning' : updateInfo?.status === 'unavailable' ? 'neutral' : 'success'}>
            {updateStatus === 'checking'
              ? t("settings.checking_for_updates")
              : updateInfo?.latestVersion ?? t("settings.update_check_unavailable")}
          </Badge>
        </SettingRow>
        {!updateAvailable && updateInfo?.latestVersion && (<p className="mt-2 px-1 text-[11.5px] text-[var(--text-quaternary)]">
          {t("settings.up_to_date")}
        </p>)}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={13}/>} loading={updateStatus === 'checking'} onClick={() => void checkForUpdates()}>
            {t("settings.recheck_updates")}
          </Button>
          {updateInfo?.updateUrl && (<Button size="sm" variant="primary" icon={<ExternalLink size={13}/>} onClick={openUpdatePage}>
            {t("settings.open_official_repository")}
          </Button>)}
        </div>
      </section>)}

      {(installAvailable || installed || offlineStatus !== 'idle') && (<section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("pwa.app_installation")}</h3>
        {(installAvailable || installed) && (<SettingRow title={t("pwa.install_inkstone")} description={t("pwa.install_description")}>
            {installed
                ? <Badge tone="success">{t("pwa.installed")}</Badge>
                : <Button size="sm" variant="secondary" icon={<Download size={13}/>} loading={installing} onClick={() => void install()}>{t("pwa.install")}</Button>}
          </SettingRow>)}
        {offlineStatus !== 'idle' && (<SettingRow
          title={t("pwa.complete_offline_access")}
          description={offlineStatus === 'ready'
            ? t("pwa.complete_offline_ready_description")
            : offlineStatus === 'error'
                ? t("pwa.complete_offline_retry_description")
                : t("pwa.complete_offline_preparing_description")}>
          <Badge tone={offlineStatus === 'ready' ? 'success' : offlineStatus === 'error' ? 'warning' : 'neutral'}>
            {offlineStatus === 'ready'
                ? t("pwa.complete_offline_ready")
                : offlineStatus === 'error'
                    ? t("pwa.waiting_for_network")
                    : t("pwa.preparing_progress", {
                        completed: String(offlineCompleted),
                        total: String(offlineTotal),
                    })}
          </Badge>
        </SettingRow>)}
      </section>)}

      <section className="flex items-center justify-between rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="flex items-center gap-2.5">
          <span className="text-[var(--accent)]">
            <Logo size={20}/>
          </span>
          <div>
            <div className="text-[13px] font-semibold">{t("common.product_name")}</div>
            <div className="text-[11.5px] text-[var(--text-quaternary)]">{t("settings.version")} {site?.version ?? '—'}</div>
          </div>
        </div>
        <a
          href={GITHUB_REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("settings.open_github_repository")}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--r-md)] px-2.5 text-[11.5px] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <GitFork size={14}/>
          {t("common.github")}
        </a>
      </section>
    </div>);
}
