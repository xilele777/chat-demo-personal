import { IconMenuOutline20, IconNewChatOutline20, HistorySearchIcon } from '../base/icons.js'
import { openHistorySearch } from '../../services/chat/historySearchState.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { ChatGPTBrand } from '../base/ChatGPTBrand.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {title === undefined ? (
        <span className={styles.brand}>
          <ChatGPTBrand />
        </span>
      ) : (
        <>
          <div className={styles.title}>{title}</div>
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </>
      )}
      <IconButton
        size="xl"
        tone="primary"
        icon={<HistorySearchIcon />}
        aria-label={t('historySearch')}
        onClick={openHistorySearch}
      />
    </div>
  )
}
