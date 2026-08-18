import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ImageOff, X, ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { Tooltip, useDialogFocus, useEscape, useLockScroll } from '../../components/overlay';
import { useUi } from '../../store/ui';
import { t } from "../../lib/i18n";
export function Lightbox() {
    const lightbox = useUi((s) => s.lightbox);
    const setLightbox = useUi((s) => s.setLightbox);
    const panelRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    const [failed, setFailed] = useState(false);
    const close = () => setLightbox(null);
    useEscape(Boolean(lightbox), close);
    useLockScroll(Boolean(lightbox));
    useDialogFocus(Boolean(lightbox), panelRef);
    useLayoutEffect(() => {
        setScale(1);
        setFailed(false);
    }, [lightbox?.src]);
    useEffect(() => {
        if (!lightbox)
            return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey)
                return;
            event.preventDefault();
            setScale((s) => Math.min(6, Math.max(0.3, s - event.deltaY * 0.002)));
        };
        window.addEventListener('wheel', onWheel, { passive: false });
        return () => window.removeEventListener('wheel', onWheel);
    }, [lightbox]);
    if (!lightbox)
        return null;
    return createPortal(<div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("preview.image_preview")} tabIndex={-1} className="app-viewport-fixed anim-fade fixed z-[260] flex items-center justify-center bg-[oklch(0%_0_0/78%)] backdrop-blur-[2px] outline-none" onClick={close}>
      <div className="absolute top-[calc(12px+env(safe-area-inset-top))] right-2 flex items-center gap-1 md:top-4 md:right-4" onClick={(e) => e.stopPropagation()}>
        <Tooltip label={t("common.zoom_out")} side="bottom">
          <IconButton label={t("common.zoom_out")} disabled={failed || scale <= 0.3} onClick={() => setScale((s) => Math.max(0.3, s - 0.25))} className="text-white/70 hover:bg-white/10 hover:text-white">
            <ZoomOut size={16}/>
          </IconButton>
        </Tooltip>
        <span aria-live="polite" className="w-11 text-center text-[11.5px] tabular text-white/60">
          {Math.round(scale * 100)}%
        </span>
        <Tooltip label={t("common.zoom_in")} side="bottom">
          <IconButton label={t("common.zoom_in")} disabled={failed || scale >= 6} onClick={() => setScale((s) => Math.min(6, s + 0.25))} className="text-white/70 hover:bg-white/10 hover:text-white">
            <ZoomIn size={16}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("preview.download_original_image")} side="bottom">
          <a href={lightbox.src} download target="_blank" rel="noreferrer" aria-label={t("preview.download_original_image")} className="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-white/70 transition-colors hover:bg-white/10 hover:text-white md:size-7">
            <Download size={16}/>
          </a>
        </Tooltip>
        <Tooltip label={t("common.close")} combo="escape" side="bottom">
          <IconButton label={t("common.close")} onClick={close} className="text-white/70 hover:bg-white/10 hover:text-white">
            <X size={17}/>
          </IconButton>
        </Tooltip>
      </div>

      {failed ? (<div role="status" className="flex max-w-[80vw] flex-col items-center gap-2 rounded-[var(--r-lg)] bg-black/35 px-5 py-4 text-center text-[12px] text-white/75">
          <ImageOff size={24}/>
          {t("preview.could_not_load_image")}
        </div>) : (<img src={lightbox.src} alt={lightbox.alt} onError={() => setFailed(true)} onClick={(e) => e.stopPropagation()} onDoubleClick={() => setScale((s) => (s === 1 ? 2 : 1))} style={{ transform: `scale(${scale})` }} className={`max-h-[86vh] max-w-[92vw] rounded-[var(--r-md)] object-contain transition-transform duration-200 ease-[var(--ease-out)] ${scale === 1 ? 'cursor-zoom-in' : 'cursor-zoom-out'}`}/>)}

      {lightbox.alt && (<div className="absolute bottom-[calc(16px+env(safe-area-inset-bottom))] left-1/2 max-w-[82vw] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1.5 text-[12px] text-white/80 md:bottom-6 md:max-w-[70vw]">
          {lightbox.alt}
        </div>)}
    </div>, document.body);
}
