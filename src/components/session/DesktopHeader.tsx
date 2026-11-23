import { useSettings } from '../../services/settings.js'
import { CollapsedSider } from '../sider/CollapsedSider.js'
import styles from './DesktopHeader.module.css'

/** Keep sidebar controls and the title in the same layout flow. */
export const DesktopHeader = ({ title }: { title?: string }) => {
  const siderCollapsed = useSettings((state) => state.siderCollapsed)
  return (
    <div className={styles.header} data-chat-header>
      <div
        className={`${styles.controls} ${siderCollapsed ? styles.controlsOpen : ''}`}
        aria-hidden={!siderCollapsed}
        {...({ inert: siderCollapsed ? undefined : '' } as Record<string, string | undefined>)}
      >
        <CollapsedSider />
      </div>
      {title ? <div className={styles.title}>{title}</div> : null}
    </div>
  )
}
