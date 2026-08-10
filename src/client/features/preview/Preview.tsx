import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { cn } from '../../lib/cn'
import { truncateText } from '@shared/text-utils'
import { useDebounced } from '../../lib/hooks'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { parseWikiTarget, renderMarkdown, type Heading } from '../../lib/markdown/renderer'
import { resolveNoteEmbeds } from '../../lib/markdown/embeds'
import { t, useLocale } from '../../lib/i18n'
import { slugifyHeading } from '@shared/markdown-utils'
import {
  enhancePreview,
  renderPendingMermaid,
  resetMermaidNode,
} from '../../lib/markdown/enhance'
import { updateTaskAtSourceLine } from '../../editor/commands'
import { useUi } from '../../store/ui'
import { useNotes, findNoteByTitle } from '../../store/notes'
import { useSession } from '../../store/session'
import { previewSourceAnchors } from './preview-anchors'
import { moveMarkdownTabFocus, selectMarkdownTab } from './markdown-tabs'

export interface PreviewProps {
  content: string
  noteId?: string
  noteTitle?: string
  onHeadings?: (headings: Heading[]) => void
  scrollerRef?: RefObject<HTMLDivElement | null>
  onRendered?: () => void
  className?: string
}

export function Preview({
  content,
  noteId,
  noteTitle,
  onHeadings,
  scrollerRef: externalScrollerRef,
  onRendered,
  className,
}: PreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const internalScrollerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = externalScrollerRef ?? internalScrollerRef
  const settings = useSession((s) => s.settings)
  const locale = useLocale()
  const setLightbox = useUi((s) => s.setLightbox)
  const openView = useUi((s) => s.openView)
  const toast = useUi((s) => s.toast)
  const openNote = useNotes((s) => s.openNote)
  const createNote = useNotes((s) => s.createNote)
  const editContent = useNotes((s) => s.editContent)
  const activeNoteId = useUi((s) => s.activeNoteId)
  const fallbackTitle = useNotes((s) => (activeNoteId ? s.notes[activeNoteId]?.title ?? '' : ''))
  const sourceNoteId = noteId ?? activeNoteId
  const currentTitle = noteTitle ?? fallbackTitle


  const debounced = useDebounced(content, 90)
  const rendered = useMemo(() => renderMarkdown(debounced), [debounced, locale])
  const [committedHtml, setCommittedHtml] = useState(rendered.html)
  const committedHtmlRef = useRef(committedHtml)
  const committedSourceRef = useRef(debounced)
  const preparationRef = useRef(0)
  const mermaidRevisionRef = useRef(0)
  const pendingViewportRef = useRef<PreviewViewport | null>(null)
  const copyResetTimersRef = useRef(new Map<HTMLElement, number>())
  const wikiNavigationRef = useRef(0)
  const wikiScrollCleanupRef = useRef<() => void>(() => {})
  const [mermaidEpoch, setMermaidEpoch] = useState(0)


  const htmlObj = useMemo(() => ({ __html: committedHtml }), [committedHtml])
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'dark')

  useEffect(() => {
    onHeadings?.(rendered.headings)
  }, [rendered.headings, onHeadings])


  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = document.documentElement.dataset.theme ?? 'dark'
      setTheme((current) => (current === next ? current : next))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => {
      wikiNavigationRef.current++
      wikiScrollCleanupRef.current()
      for (const timer of copyResetTimersRef.current.values()) window.clearTimeout(timer)
      copyResetTimersRef.current.clear()
    },
    [],
  )

  const startMermaidRender = useCallback(() => {
    const host = hostRef.current
    if (!host || !settings.preview.mermaid) return

    const revision = ++mermaidRevisionRef.current
    void renderPendingMermaid<PreviewViewport | null>(host, theme === 'dark', {
      isCurrent: () => revision === mermaidRevisionRef.current && hostRef.current === host,
      beforeUpdate: () => {
        const scroller = scrollerRef.current
        return scroller ? capturePreviewViewport(scroller, host) : null
      },
      afterUpdate: (snapshot) => {
        const scroller = scrollerRef.current
        if (snapshot && scroller && hostRef.current === host) {
          restorePreviewViewport(scroller, host, snapshot)
        }
        onRendered?.()
      },
    })
  }, [onRendered, scrollerRef, settings.preview.mermaid, theme])


  useEffect(() => {
    const revision = ++preparationRef.current
    let cancelled = false

    const staging = document.createElement('div')
    staging.innerHTML = rendered.html

    const prepare = async () => {
      if (rendered.hasEmbeds) {
        await resolveNoteEmbeds(staging, {
          currentContent: debounced,
          currentTitle,
          isCurrent: () => !cancelled && revision === preparationRef.current,
        })
      }
      await enhancePreview(staging, {
        math: settings.preview.math,
        mermaid: settings.preview.mermaid,
        dark: theme === 'dark',
      })
      if (cancelled || revision !== preparationRef.current) return

      const nextHtml = staging.innerHTML
      committedSourceRef.current = debounced
      if (nextHtml !== committedHtmlRef.current) {
        const scroller = scrollerRef.current
        const host = hostRef.current
        pendingViewportRef.current =
          scroller && host ? capturePreviewViewport(scroller, host) : null
        committedHtmlRef.current = nextHtml
        setCommittedHtml(nextHtml)
      }
      setMermaidEpoch((current) => current + 1)
    }
    void prepare()

    return () => {
      cancelled = true
    }
  }, [
    currentTitle,
    debounced,
    rendered.hasEmbeds,
    rendered.html,
    scrollerRef,
    settings.preview.math,
    settings.preview.mermaid,
    theme,
  ])


  useEffect(() => {
    if (!mermaidEpoch || !settings.preview.mermaid) return
    const timer = window.setTimeout(startMermaidRender, 60)
    return () => {
      window.clearTimeout(timer)
      mermaidRevisionRef.current++
    }
  }, [mermaidEpoch, settings.preview.mermaid, startMermaidRender])


  useLayoutEffect(() => {
    const snapshot = pendingViewportRef.current
    pendingViewportRef.current = null
    const scroller = scrollerRef.current
    const host = hostRef.current
    if (snapshot && scroller && host) restorePreviewViewport(scroller, host, snapshot)
    onRendered?.()
  }, [committedHtml, onRendered, scrollerRef])


  const onClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement

    const mermaidRetry = target.closest<HTMLElement>('[data-mermaid-retry]')
    if (mermaidRetry) {
      const block = mermaidRetry.closest<HTMLElement>('[data-mermaid]')
      if (block) {
        const scroller = scrollerRef.current
        const host = hostRef.current
        const snapshot =
          scroller && host ? capturePreviewViewport(scroller, host) : null
        resetMermaidNode(block)
        if (snapshot && scroller && host) restorePreviewViewport(scroller, host, snapshot)
        startMermaidRender()
      }
      return
    }

    const copyButton = target.closest<HTMLElement>('[data-copy]')
    if (copyButton) {
      const code = copyButton.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
      if (!navigator.clipboard?.writeText) {
        toast({ title: t("preview.could_not_copy"), tone: 'danger' })
        return
      }
      void navigator.clipboard
        .writeText(code)
        .then(() => {
          if (!hostRef.current?.contains(copyButton)) return
          const existingTimer = copyResetTimersRef.current.get(copyButton)
          if (existingTimer !== undefined) window.clearTimeout(existingTimer)
          copyButton.textContent = t("common.copied")
          copyButton.classList.add('copied')
          const timer = window.setTimeout(() => {
            if (hostRef.current?.contains(copyButton)) {
              copyButton.textContent = t("common.copy")
              copyButton.classList.remove('copied')
            }
            copyResetTimersRef.current.delete(copyButton)
          }, 900)
          copyResetTimersRef.current.set(copyButton, timer)
        })
        .catch(() => toast({ title: t("preview.could_not_copy"), tone: 'danger' }))
      return
    }

    const checkbox = target.closest<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox) {
      if (checkbox.disabled || checkbox.closest('.note-embed-body')) return


      const checked = checkbox.checked
      const line = Number(checkbox.dataset.taskLine)
      if (Number.isInteger(line) && line >= 0) {
        const committedSource = committedSourceRef.current
        if (content !== committedSource) {
          checkbox.checked = !checked
          toast({ title: t("preview.the_preview_is_updating_try_again_in_a_moment"), tone: 'warning' })
          return
        }
        const next = updateTaskAtSourceLine(committedSource, line, checked)
        if (next == null || !sourceNoteId) {
          checkbox.checked = !checked
          toast({ title: t("preview.could_not_update_this_task"), tone: 'warning' })
          return
        }
        editContent(sourceNoteId, next)
      }
      return
    }

    const tabButton = target.closest<HTMLButtonElement>('[data-tab-button]')
    if (tabButton) {
      event.preventDefault()
      selectMarkdownTab(tabButton)
      return
    }

    const wikilink = target.closest<HTMLElement>('[data-wikilink]')
    if (wikilink) {
      event.preventDefault()
      wikiScrollCleanupRef.current()
      const navigation = ++wikiNavigationRef.current
      const parsed = parseWikiTarget(decodeDataValue(wikilink.dataset.wikilink))
      const note = parsed.noteTitle ? findNoteByTitle(parsed.noteTitle) : sourceNoteId ? useNotes.getState().notes[sourceNoteId] : undefined
      if (note) {
        void openNote(note.id).then(() => {
          const isCurrent = () =>
            navigation === wikiNavigationRef.current &&
            useUi.getState().activeNoteId === note.id
          if (!isCurrent()) return
          wikiScrollCleanupRef.current = scrollToWikiTarget(hostRef, parsed, isCurrent)
        })
      } else if (parsed.noteTitle) {
        void createNote({ title: parsed.noteTitle, open: false }).then((id) => {
          if (!id) return
          toast({ title: t("preview.created_title", { title: parsed.noteTitle }), tone: 'success' })
          if (
            navigation === wikiNavigationRef.current &&
            useUi.getState().activeNoteId === sourceNoteId
          ) {
            void openNote(id)
          }
        })
      }
      return
    }

    const blockReference = target.closest<HTMLElement>('[data-block-ref]')
    if (blockReference) {
      event.preventDefault()
      scrollElementIntoView(hostRef.current?.querySelector(`#${CSS.escape(`^${blockReference.dataset.blockRef ?? ''}`)}`))
      return
    }

    const tag = target.closest<HTMLElement>('[data-tag]')
    if (tag) {
      event.preventDefault()
      openView('tag', { tag: decodeDataValue(tag.dataset.tag) })
      return
    }

    const image = target.closest<HTMLImageElement>('img')
    if (image?.src) {
      event.preventDefault()
      setLightbox({ src: image.src, alt: image.alt })
      return
    }

    const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]')
    if (anchor) {
      event.preventDefault()
      const rawId = anchor.getAttribute('href')!.slice(1)
      let id = rawId
      try {
        id = decodeURIComponent(rawId)
      } catch {

      }
      const heading = hostRef.current?.querySelector(`#${CSS.escape(id)}`)
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]')
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      moveMarkdownTabFocus(tab, event.key)
      return
    }
    const interactiveLink = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-wikilink], [data-tag]',
    )
    if (interactiveLink && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      interactiveLink.click()
    }
  }

  return (
    <div
      ref={scrollerRef}
      className={cn('h-full overflow-y-auto overscroll-contain px-4 py-3', className)}
      data-preview-scroller
    >
      <div
        ref={hostRef}
        onClick={onClick}
        onKeyDown={onKeyDown}
        data-font={settings.appearance.proseFont}
        data-preview-content
        className="ink-prose"
        dangerouslySetInnerHTML={htmlObj}
      />
    </div>
  )
}

function scrollToWikiTarget(
  hostRef: RefObject<HTMLDivElement | null>,
  target: ReturnType<typeof parseWikiTarget>,
  isCurrent: () => boolean,
): () => void {
  if (!target.heading && !target.blockId) return () => {}
  const id = target.blockId ? `^${target.blockId}` : slugifyHeading(target.heading!)
  let attempts = 0
  let timer = 0
  let cancelled = false
  const find = () => {
    if (cancelled || !isCurrent()) return
    const element = hostRef.current?.querySelector(`#${CSS.escape(id)}`)
    if (element) scrollElementIntoView(element)
    else if (++attempts < 12) timer = window.setTimeout(find, 50)
  }
  find()
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}

function scrollElementIntoView(element: Element | null | undefined): void {
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

interface PreviewViewport {
  atTop: boolean
  atBottom: boolean
  scrollTop: number
  line: number | null
  tagName: string | null
  signature: string | null
  offset: number
}

function capturePreviewViewport(scroller: HTMLElement, host: HTMLElement): PreviewViewport {
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const atTop = scroller.scrollTop <= 2
  const atBottom = maxScroll > 0 && scroller.scrollTop >= maxScroll - 4
  const scrollerRect = scroller.getBoundingClientRect()
  const viewportTop = scrollerRect.top + previewPaddingTop(scroller)
  const anchors = previewSourceAnchors(host)
  const anchor =
    anchors.reduce<HTMLElement | null>((closest, candidate) => {
      if (!closest) return candidate
      const closestDistance = Math.abs(closest.getBoundingClientRect().top - viewportTop)
      const candidateDistance = Math.abs(candidate.getBoundingClientRect().top - viewportTop)
      return candidateDistance < closestDistance ? candidate : closest
    }, null)

  return {
    atTop,
    atBottom,
    scrollTop: scroller.scrollTop,
    line: anchor ? sourceLine(anchor) : null,
    tagName: anchor?.tagName ?? null,
    signature: anchor ? previewAnchorSignature(anchor) : null,
    offset: anchor ? anchor.getBoundingClientRect().top - scrollerRect.top : 0,
  }
}

function restorePreviewViewport(
  scroller: HTMLElement,
  host: HTMLElement,
  snapshot: PreviewViewport,
): void {
  if (snapshot.atTop) {
    if (scroller.scrollTop > 0.5) scroller.scrollTop = 0
    return
  }
  if (snapshot.atBottom) {
    const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (Math.abs(scroller.scrollTop - bottom) > 0.5) scroller.scrollTop = bottom
    return
  }

  const anchors = previewSourceAnchors(host)
  let anchor: HTMLElement | null = null

  if (snapshot.signature) {
    const matches = anchors.filter(
      (candidate) => previewAnchorSignature(candidate) === snapshot.signature,
    )
    anchor = closestSourceLine(matches, snapshot.line)
  }
  if (!anchor && snapshot.line != null) {
    const sameLine = anchors.filter(
      (candidate) =>
        sourceLine(candidate) === snapshot.line &&
        (!snapshot.tagName || candidate.tagName === snapshot.tagName),
    )
    anchor = sameLine[0] ?? closestSourceLine(anchors, snapshot.line)
  }

  if (!anchor) {
    const fallback = Math.min(
      snapshot.scrollTop,
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    )
    if (Math.abs(scroller.scrollTop - fallback) > 0.5) scroller.scrollTop = fallback
    return
  }

  const currentOffset =
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const correction = currentOffset - snapshot.offset
  if (Math.abs(correction) > 0.5) scroller.scrollTop += correction
}

function closestSourceLine(
  elements: HTMLElement[],
  targetLine: number | null,
): HTMLElement | null {
  if (!elements.length) return null
  if (targetLine == null) return elements[0]!
  return elements.reduce((closest, candidate) => {
    const closestDistance = Math.abs((sourceLine(closest) ?? targetLine) - targetLine)
    const candidateDistance = Math.abs((sourceLine(candidate) ?? targetLine) - targetLine)
    return candidateDistance < closestDistance ? candidate : closest
  })
}

function sourceLine(element: HTMLElement): number | null {
  const value = Number(element.dataset.line)
  return Number.isFinite(value) ? value : null
}

function previewAnchorSignature(element: HTMLElement): string {
  const kind =
    element.dataset.lang ??
    (element.dataset.math ? decodeDataValue(element.dataset.math) : undefined) ??
    (element.dataset.mermaid ? decodeDataValue(element.dataset.mermaid) : undefined) ??
    element.tagName
  const text = truncateText((element.textContent ?? '').replace(/\s+/g, ' ').trim(), 240)
  return `${element.tagName}\u0000${kind}\u0000${text}`
}

function previewPaddingTop(scroller: HTMLElement): number {
  const value = Number.parseFloat(getComputedStyle(scroller).paddingTop)
  return Number.isFinite(value) ? value : 0
}
