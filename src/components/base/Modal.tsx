import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  className,
  overlayClassName,
  mainClassName,
  hideHeading = false,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  className?: string
  overlayClassName?: string
  /** 内容区的 class */
  mainClassName?: string
  hideHeading?: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  const pressedOutside = useRef(false)
  onCloseRef.current = onClose
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    dialog.showModal()
    return () => dialog.close()
  }, [])

  return createPortal(
    <dialog
      ref={dialogRef}
      {...({ closedby: 'closerequest' } as Record<string, string>)}
      className={clsx(styles.overlay, overlayClassName)}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onCloseRef.current()
      }}
      onPointerDown={(event) => {
        pressedOutside.current = event.target === event.currentTarget && event.button === 0
      }}
      onPointerUp={(event) => {
        if (pressedOutside.current && event.target === event.currentTarget) {
          onCloseRef.current()
        }
        pressedOutside.current = false
      }}
      onPointerCancel={() => {
        pressedOutside.current = false
      }}
    >
      <div className={clsx(styles.content, className)}>
        <div className={hideHeading ? styles.hiddenHeader : styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </dialog>,
    document.body
  )
}
