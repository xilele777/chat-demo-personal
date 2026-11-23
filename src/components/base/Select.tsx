import clsx from 'clsx'
import { useId, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import styles from './Select.module.css'

export type SelectOption<T extends string> = { value: T; label: string; lang?: string }

/**
 * 胶囊形选择器：触发器高 36px、圆角 18px、浅灰底，下拉菜单选中项右侧打勾；
 * 点外部或 Esc 关闭。value 不匹配任何选项时触发器显示 placeholder。
 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const menuId = useId()
  const current = options.find((option) => option.value === value)
  // 菜单贴右侧展开，最多 320px 高，超出在菜单内滚动
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { align: 'end', maxHeight: 320, minSpace: 160 })
  // Esc 只关菜单，不让外层弹窗一起关闭
  const close = () => {
    if (floatingRef.current?.contains(document.activeElement)) {
      anchorRef.current?.focus({ preventScroll: true })
    }
    setOpen(false)
  }
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })

  const showMenu = (fromEnd = false) => {
    const selectedIndex = options.findIndex((option) => option.value === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : fromEnd ? options.length - 1 : 0)
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (open && !disabled) {
      const option = floatingRef.current?.querySelector<HTMLElement>('[tabindex="0"]')
      option?.focus({ preventScroll: true })
      option?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, disabled, floatingRef, open])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && !disabled ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : showMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            showMenu(event.key === 'ArrowUp')
          }
        }}
      >
        {current ? (
          <span lang={current.lang}>{current.label}</span>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={floatingRef}
              id={menuId}
              className={styles.menu}
              style={position ?? undefined}
              role="listbox"
              aria-label={ariaLabel}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setOpen(false)
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Tab') {
                  close()
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const direction = event.key === 'ArrowDown' ? 1 : -1
                  setActiveIndex((index) => (index + direction + options.length) % options.length)
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  setActiveIndex(event.key === 'Home' ? 0 : options.length - 1)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  const option = options[activeIndex]
                  if (option) {
                    close()
                    onChange(option.value)
                  }
                }
              }}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  role="option"
                  lang={option.lang}
                  aria-selected={option.value === value}
                  tabIndex={index === activeIndex ? 0 : -1}
                  className={styles.option}
                  onClick={() => {
                    close()
                    onChange(option.value)
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <IconCheckOutline16 /> : null}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
