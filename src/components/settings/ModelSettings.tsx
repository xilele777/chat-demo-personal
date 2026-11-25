import { useEffect, useId, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { cloudMode, useCloud } from '../../services/cloud.js'
import { availableModels, loadModels, modelCapabilities, useModels } from '../../services/models.js'
import { setCustomModels, setModel, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import styles from './ModelSettings.module.css'

export const ModelSettings = () => {
  const t = useTranslate()
  const id = useId()
  const config = useCloud((state) => state.config)
  const { models, loading, error } = useModels()
  const custom = useSettings((state) => state.customModels)
  const selected = useSettings((state) => state.model) || config?.model || ''
  const [value, setValue] = useState('')
  const options = availableModels(config?.model, custom, models, selected)
  const capabilities = modelCapabilities(selected)
  const budgets = capabilities
    ? { input: capabilities.inputTokens, output: capabilities.outputTokens }
    : config?.tokenBudgets
  useEffect(() => {
    if (cloudMode && !models.length) {
      void loadModels()
    }
  }, [models.length])
  if (!cloudMode) {
    return <p>{t('modelsCloudOnly')}</p>
  }
  return (
    <div className={styles.content}>
      <div className={styles.selection}>
        <span>{t('selectedModel')}</span>
        <Select
          ariaLabel={t('selectedModel')}
          className={styles.selector}
          value={selected}
          options={options.map((model) => ({ value: model, label: model }))}
          onChange={setModel}
          disabled={!options.length}
        />
      </div>
      {budgets ? (
        <div className={styles.description} role="status" aria-live="polite">
          <p>
            {t('modelTokenBudgets', {
              input: budgets.input.toLocaleString(),
              output: budgets.output.toLocaleString(),
            })}
          </p>
          <p>{t('modelTokenBudgetsHelp')}</p>
          {capabilities ? (
            <>
              <p>
                {capabilities.contextTokens === null
                  ? t('modelContextUnknown')
                  : t('modelContextWindow', {
                      tokens: capabilities.contextTokens.toLocaleString(),
                    })}
              </p>
              <p>
                {t('modelConfiguredCapabilities', {
                  images: t(capabilities.images ? 'modelEnabled' : 'modelDisabled'),
                  tools: t(capabilities.tools ? 'modelEnabled' : 'modelDisabled'),
                })}
              </p>
              {capabilities.source === 'fallback' ? <p>{t('modelFallback')}</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
      <Button variant="outlined" size="m" disabled={loading} onClick={() => void loadModels()}>
        {t(loading ? 'modelsLoading' : 'modelsRefresh')}
      </Button>
      {error ? (
        <p role="status" className={styles.description}>
          {t('modelsUnavailable')}
        </p>
      ) : null}
      <form
        action="/api/models"
        method="post"
        aria-label={t('modelAdd')}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          const model = value.trim()
          if (!model) {
            return
          }
          setCustomModels([...new Set([...custom, model])])
          setModel(model)
          setValue('')
        }}
      >
        <label htmlFor={`${id}-custom`}>{t('modelAdd')}</label>
        <div className={styles.addRow}>
          <input
            id={`${id}-custom`}
            name="modelId"
            required
            maxLength={200}
            pattern="[a-zA-Z0-9][a-zA-Z0-9._:\/@+\-]*"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="model-id"
          />
          <Button type="submit" variant="outlined" size="m">
            {t('modelAddSelect')}
          </Button>
        </div>
      </form>
      {custom.length ? (
        <div className={styles.custom}>
          <h3>{t('customModels')}</h3>
          {custom.map((model) => (
            <div key={model} className={styles.row}>
              <span className={styles.grow}>{model}</span>
              <Button
                size="s"
                variant="outlined"
                onClick={() => {
                  setCustomModels(custom.filter((id) => id !== model))
                  if (selected === model && !models.includes(model) && config) {
                    setModel(config.model)
                  }
                }}
              >
                {t('remove')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
