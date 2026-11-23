import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import styles from './ImagePreview.module.css'

export const ImagePreview = ({
  url,
  name,
  children,
  className,
}: {
  url: string
  name: string
  children: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const element = dialog.current
    if (!open || !element) {
      return
    }
    element.showModal()
    if ('closedBy' in HTMLDialogElement.prototype) {
      return
    }
    const outside = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
    }
    let pressedOutside = false
    const down = (event: PointerEvent) => {
      pressedOutside = outside(event)
    }
    const up = (event: PointerEvent) => {
      if (pressedOutside && outside(event)) {
        element.close()
      }
    }
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointerup', up)
    return () => {
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointerup', up)
    }
  }, [open])
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`${t('imagePreview')}：${name}`}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className={styles.dialog}
            {...({ closedby: 'any' } as object)}
            aria-label={`${t('imagePreview')}：${name}`}
            onClose={() => setOpen(false)}
          >
            <div className={styles.toolbar}>
              <span className={styles.name}>{name}</span>
              <a href={url} download={name}>
                {t('downloadImage')}
              </a>
              <form method="dialog">
                <button type="submit" autoFocus>
                  {t('close')}
                </button>
              </form>
            </div>
            <img className={styles.image} src={url} alt={name} />
          </dialog>,
          document.body
        )}
    </>
  )
}
