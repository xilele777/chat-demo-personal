import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../app/viewport.js'
import { useAnchoredPosition, useDelayedOpen } from './anchored.js'
import styles from './Tooltip.module.css'

export type TooltipPlacement = 'top' | 'bottom'

const ENTER_DELAY = 100

/**
 * 悬停或聚焦后出现，支持移入提示及 Escape 关闭，移动端不显示。
 * 触发元素外包一层 display: contents，不影响布局。
 */
export const Tooltip = ({
  content,
  placement = 'top',
  children,
}: {
  content: ReactNode
  placement?: TooltipPlacement
  children: ReactNode
}) => {
  const isMobile = useIsMobile()
  const id = useId()
  const focused = useRef(false)
  const hovered = useRef(false)
  const { open, setOpen, schedule, cancel } = useDelayedOpen()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { side: placement, align: 'center', measureFirstChild: true, measureKey: content }
  )

  useEffect(() => () => cancel(), [cancel])

  useLayoutEffect(() => {
    const trigger = anchorRef.current?.querySelector('button, a, input, [tabindex]')
    if (!trigger || typeof content !== 'string') {
      return
    }
    const name = trigger.getAttribute('aria-label') ?? trigger.textContent?.trim()
    const attribute = name ? 'aria-describedby' : 'aria-labelledby'
    if (name === content || trigger.hasAttribute(attribute)) {
      return
    }
    trigger.setAttribute(attribute, id)
    return () => {
      if (trigger.getAttribute(attribute) === id) {
        trigger.removeAttribute(attribute)
      }
    }
  }, [content, id, anchorRef])

  // 滚动时收起提示。
  useEffect(() => {
    if (!open) {
      return
    }
    const onScroll = () => setOpen(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel()
        setOpen(false)
      }
    }
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen, cancel])

  const visible = open && !isMobile && Boolean(content)
  const leave = () => {
    hovered.current = false
    if (!focused.current) {
      schedule(false, 120)
    }
  }

  return (
    <>
      <span
        ref={anchorRef}
        className={styles.trigger}
        onMouseEnter={() => {
          hovered.current = true
          schedule(true, ENTER_DELAY)
        }}
        onMouseLeave={leave}
        onFocus={() => {
          focused.current = true
          cancel()
          setOpen(true)
        }}
        onBlur={() => {
          focused.current = false
          if (!hovered.current) {
            schedule(false, 120)
          }
        }}
      >
        {children}
      </span>
      {content
        ? createPortal(
            <div
              ref={floatingRef}
              id={id}
              hidden={!visible}
              role="tooltip"
              className={styles.tooltip}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              onMouseEnter={() => {
                hovered.current = true
                cancel()
                setOpen(true)
              }}
              onMouseLeave={leave}
            >
              {content}
            </div>,
            anchorRef.current?.closest('dialog') ?? document.body
          )
        : null}
    </>
  )
}
