import { useTranslate } from '../../i18n/index.js'
import { cloudMode, useCloud } from '../../services/cloud.js'
import { availableModels, useModels } from '../../services/models.js'
import { setModel, useSettings } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { Select } from '../base/Select.js'
import styles from './ModelPicker.module.css'

export const ModelPicker = () => {
  const t = useTranslate()
  const config = useCloud((state) => state.config)
  const selected = useSettings((state) => state.model) || config?.model || ''
  const custom = useSettings((state) => state.customModels)
  const remote = useModels((state) => state.models)
  const disabled = useChatStore((state) => state.importingHistory)
  if (!cloudMode) {
    return null
  }
  const models = availableModels(config?.model, custom, remote, selected)
  return (
    <Select
      className={styles.trigger}
      ariaLabel={t('selectedModel')}
      value={selected}
      options={models.map((model) => ({ value: model, label: model }))}
      onChange={setModel}
      disabled={disabled || !models.length}
      align="start"
    />
  )
}
