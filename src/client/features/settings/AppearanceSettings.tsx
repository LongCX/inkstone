import type { AccentName, AppLocale, BackgroundName, ProseFont, ProseWidth, ThemePref, UiDensity } from '@shared/types'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Segmented, SettingRow, Slider } from '../../components/form'
import { Tooltip } from '../../components/overlay'
import { useSession } from '../../store/session'
import { switchThemeWithTransition } from '../../store/ui'
import { t, type MessageKey } from '../../lib/i18n'

const ACCENT_MESSAGE_KEYS: Record<AccentName, MessageKey> = {
  cinnabar: 'settings.accent.cinnabar',
  indigo: 'settings.accent.indigo',
  celadon: 'settings.accent.celadon',
  amber: 'settings.accent.amber',
  terracotta: 'settings.accent.terracotta',
  wisteria: 'settings.accent.wisteria',
  graphite: 'settings.accent.graphite',
}

export function AppearanceSettings({
  accents,
}: {
  accents: { name: AccentName; swatch: string }[]
}) {
  const settings = useSession((s) => s.settings)
  const update = useSession((s) => s.updateSettings)
  const appearance = settings.appearance

  return (
    <div>
      <section>
        <SettingRow title={t("settings.interface_language")}>
          <Segmented<AppLocale>
            label={t("settings.interface_language")}
            value={appearance.language}
            onChange={(language) => void update({ appearance: { language } })}
            options={[
              { value: 'zh-CN', label: t("settings.simplified_chinese") },
              { value: 'en-US', label: t("settings.english") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("settings.theme")}>
          <Segmented<ThemePref>
            label={t("settings.theme")}
            value={appearance.theme}
            onChange={(theme) => {
              switchThemeWithTransition(theme, undefined, () => update({ appearance: { theme } }))
            }}
            options={[
              { value: 'light', label: <Sun size={12.5} />, title: t("settings.light") },
              { value: 'dark', label: <Moon size={12.5} />, title: t("settings.dark") },
              { value: 'system', label: <Monitor size={12.5} />, title: t("settings.system") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("settings.accent_color")}>
          <div role="group" aria-label={t("settings.accent_color")} className="flex items-center gap-1.5">
            {accents.map((accent) => (
              <Tooltip key={accent.name} label={t(ACCENT_MESSAGE_KEYS[accent.name])}>
                <button
                  type="button"
                  onClick={() => void update({ appearance: { accent: accent.name } })}
                  aria-label={t(ACCENT_MESSAGE_KEYS[accent.name])}
                  aria-pressed={appearance.accent === accent.name}
                  className={cn(
                    'relative flex size-6 items-center justify-center rounded-full transition-transform duration-[var(--dur-fast)] ease-[var(--ease-spring)]',
                    'hover:scale-110 active:scale-95',
                    appearance.accent === accent.name && 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-overlay)]',
                  )}
                  style={{ background: accent.swatch }}
                >
                  {appearance.accent === accent.name && (
                    <Check size={12} strokeWidth={3} className="text-white drop-shadow-sm" />
                  )}
                </button>
              </Tooltip>
            ))}
          </div>
        </SettingRow>

        <SettingRow title={t("settings.background_color")}>
          <div role="group" aria-label={t("settings.background_color")} className="flex items-center gap-2">
            {([
              { name: 'paper', label: t("settings.background_paper"), swatch: '#f7f5f1' },
              { name: 'white', label: t("settings.background_white"), swatch: '#ffffff' },
            ] satisfies { name: BackgroundName; label: string; swatch: string }[]).map((background) => (
              <button
                key={background.name}
                type="button"
                onClick={() => void update({ appearance: { background: background.name } })}
                aria-pressed={appearance.background === background.name}
                className={cn(
                  'flex h-8 min-w-[84px] items-center gap-2 rounded-[var(--r-md)] border px-2.5 text-[11.5px] transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)]',
                  appearance.background === background.name
                    ? 'border-[var(--accent)] bg-[var(--accent-softer)] shadow-[0_0_0_2px_var(--accent-ring)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-base)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-4 rounded-full border border-black/10 shadow-sm"
                  style={{ background: background.swatch }}
                />
                <span>{background.label}</span>
                {appearance.background === background.name && <Check size={11} className="ml-auto text-[var(--accent)]" />}
              </button>
            ))}
          </div>
        </SettingRow>

        <SettingRow title={t("settings.interface_density")}>
          <Segmented<UiDensity>
            label={t("settings.interface_density")}
            value={appearance.density}
            onChange={(density) => void update({ appearance: { density } })}
            options={[
              { value: 'comfortable', label: t("settings.comfortable") },
              { value: 'compact', label: t("settings.compact") },
            ]}
          />
        </SettingRow>
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t("settings.preview_typography")}
        </h3>

        <SettingRow title={t("settings.body_font")}>
          <Segmented<ProseFont>
            label={t("settings.body_font")}
            value={appearance.proseFont}
            onChange={(proseFont) => void update({ appearance: { proseFont } })}
            options={[
              { value: 'sans', label: t("common.sans_serif") },
              { value: 'serif', label: t("settings.serif") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("settings.body_text_size")}>
          <Slider
            label={t("settings.body_text_size")}
            className="w-[200px]"
            value={appearance.proseSize}
            min={13}
            max={22}
            onChange={(proseSize) => void update({ appearance: { proseSize } })}
            suffix="px"
          />
        </SettingRow>

        <SettingRow title={t("settings.line_height")}>
          <Slider
            label={t("settings.line_height")}
            className="w-[200px]"
            value={appearance.proseLineHeight}
            min={1.4}
            max={2.2}
            step={0.05}
            onChange={(proseLineHeight) => void update({ appearance: { proseLineHeight } })}
          />
        </SettingRow>

        <SettingRow title={t("settings.content_width")}>
          <Segmented<ProseWidth>
            label={t("settings.content_width")}
            value={appearance.proseWidth}
            onChange={(proseWidth) => void update({ appearance: { proseWidth } })}
            options={[
              { value: 'narrow', label: t("settings.narrow") },
              { value: 'normal', label: t("settings.standard") },
              { value: 'wide', label: t("settings.wide") },
              { value: 'full', label: t("settings.full") },
            ]}
          />
        </SettingRow>
      </section>

      <PreviewSample />
    </div>
  )
}


function PreviewSample() {
  const appearance = useSession((s) => s.settings.appearance)
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {t("settings.preview")}
      </h3>
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3">
        <div
          className="ink-prose"
          data-font={appearance.proseFont}
          style={{ maxWidth: 'none', paddingBlock: 0 }}
        >
          <h3 style={{ marginTop: 0 }}>{t("settings.q_a_in_the_mountains")}</h3>
          <p>
            {t("settings.asked_why_i_wanted_to_live_in_the_green_mountains_i_smiled_without_answe")}{' '}
            {t("settings.chinese_english_and")} <code>{t("common.inline_code")}</code> {t("settings.look_at_home_together")}
          </p>
        </div>
      </div>
    </section>
  )
}
