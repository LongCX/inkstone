import { Check, Hash } from 'lucide-react'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import type { Tag } from '@shared/types'
import { Drawer } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'

export function TagAppearance({
  open,
  tag,
  onChange,
  onClose,
}: {
  open: boolean
  tag: Tag | null
  onChange: (color: string | null) => void
  onClose: () => void
}) {
  return <Drawer open={open} onClose={onClose} title={t('tags.color')} width={380}>
    {tag && <div className="space-y-7 p-4">
      <section>
        <h3 className="mb-3 text-[12px] font-semibold text-[var(--text-secondary)]">
          {t('tags.color')}
        </h3>
        <div className="grid grid-cols-6 gap-3">
          <button
            type="button"
            aria-label={t('tags.clear_color')}
            aria-pressed={!tag.color}
            onClick={() => onChange(null)}
            className={cn(
              'flex size-10 items-center justify-center rounded-full border bg-[var(--bg-base)] text-[var(--text-quaternary)] transition-transform hover:scale-105',
              !tag.color
                ? 'border-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
                : 'border-[var(--border-default)]',
            )}
          >
            <Hash size={16}/>
          </button>
          {ORGANIZER_COLORS.map((color) => <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={tag.color === color}
            onClick={() => onChange(color)}
            className={cn(
              'flex size-10 items-center justify-center rounded-full transition-transform hover:scale-105',
              tag.color === color
                && 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-surface)]',
            )}
            style={{ backgroundColor: color }}
          >
            {tag.color === color && <Check size={16} className="text-white"/>}
          </button>)}
        </div>
      </section>
    </div>}
  </Drawer>
}
