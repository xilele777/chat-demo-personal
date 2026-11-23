import { useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { cloudFetch, cloudJson, cloudMode, useCloud } from '../../services/cloud.js'
import type { McpServer } from '../../services/mcpTypes.js'
import { createId } from '../../utils/id.js'
import { Button } from '../base/Button.js'
import styles from './Connections.module.css'
import { useSettingsDialog } from './settingsDialogState.js'

type Editor = McpServer & { token?: string }
const redirectToOAuth = async (server: Editor) => {
  const response = await cloudFetch(
    `/mcp/servers/${server.id}/authorize`,
    cloudJson('POST', server)
  )
  const result = (await response.json()) as { authorizationUrl: string }
  const url = new URL(result.authorizationUrl)
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Invalid authorization URL')
  }
  location.assign(url.href)
}
export const McpSettings = () => {
  const t = useTranslate()
  const supported = useCloud((state) => state.config?.mcp)
  const oauthResult = useSettingsDialog((state) => state.oauthResult)
  const [servers, setServers] = useState<McpServer[]>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const refresh = async () => {
    const result = (await (await cloudFetch('/mcp/servers')).json()) as { servers: McpServer[] }
    setServers(result.servers)
  }
  useEffect(() => {
    if (cloudMode) {
      void refresh()
        .catch((error: Error) => setError(error.message))
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])
  const mutate = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await run()
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  if (!cloudMode) {
    return <p>{t('mcpCloudOnly')}</p>
  }
  return (
    <div className={styles.stack}>
      {!supported ? <p className={styles.description}>{t('mcpProtocolUnavailable')}</p> : null}
      {oauthResult === 'connected' ? <p role="status">{t('mcpOAuthSuccess')}</p> : null}
      {oauthResult === 'failed' ? (
        <p role="alert" className={styles.error}>
          {t('mcpOAuthFailed')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">{t('mcpLoading')}</p> : null}
      {!loading && !servers.length && !editor ? (
        <p className={styles.description}>{t('mcpEmpty')}</p>
      ) : null}
      {servers.map((server) => (
        <section
          key={server.id}
          className={`${styles.card} ${styles.stack}`}
          aria-label={server.name}
        >
          <div className={styles.row}>
            <strong className={styles.grow}>{server.name}</strong>
            <span>{t(server.enabled ? 'mcpEnabled' : 'mcpDisabled')}</span>
          </div>
          <p className={styles.description}>{server.url}</p>
          {server.authType === 'oauth' ? (
            <p className={server.oauthStatus === 'required' ? styles.error : styles.description}>
              {t(server.oauthStatus === 'authorized' ? 'mcpOAuthAuthorized' : 'mcpOAuthRequired')}
            </p>
          ) : null}
          <p className={styles.description}>
            {t('mcpToolCount', {
              count: server.tools.filter((tool) => !server.disabledTools.includes(tool.name))
                .length,
            })}
          </p>
          <div className={styles.row}>
            {server.authType === 'oauth' ? (
              <Button
                variant="outlined"
                size="s"
                disabled={busy || Boolean(editor)}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  void redirectToOAuth(server).catch((error: Error) => {
                    setError(error.message)
                    setBusy(false)
                  })
                }}
              >
                {t(server.oauthStatus === 'authorized' ? 'mcpOAuthReauthorize' : 'mcpOAuthSignIn')}
              </Button>
            ) : null}
            <Button
              variant="outlined"
              size="s"
              disabled={busy || Boolean(editor)}
              onClick={() => setEditor({ ...server })}
            >
              {t('mcpEdit')}
            </Button>
            <Button
              variant="outlined"
              size="s"
              disabled={busy || Boolean(editor)}
              onClick={() =>
                void mutate(() =>
                  cloudFetch(
                    `/mcp/servers/${server.id}`,
                    cloudJson('PUT', { ...server, enabled: !server.enabled })
                  )
                )
              }
            >
              {t(server.enabled ? 'mcpDisable' : 'mcpEnable')}
            </Button>
            <Button
              variant="dangerOutlined"
              size="s"
              disabled={busy || Boolean(editor)}
              onClick={() =>
                void mutate(() => cloudFetch(`/mcp/servers/${server.id}`, { method: 'DELETE' }))
              }
            >
              {t('remove')}
            </Button>
          </div>
        </section>
      ))}
      {editor ? (
        <McpEditor
          key={editor.id}
          initial={editor}
          onCancel={() => setEditor(null)}
          onSaved={async () => {
            await refresh()
            setEditor(null)
          }}
        />
      ) : (
        <Button
          variant="outlined"
          size="m"
          disabled={busy || loading || servers.length >= 5}
          onClick={() =>
            setEditor({
              id: createId(),
              name: '',
              url: '',
              enabled: true,
              hasToken: false,
              authType: 'bearer',
              tools: [],
              disabledTools: [],
            })
          }
        >
          {t('mcpAdd')}
        </Button>
      )}
    </div>
  )
}

const McpEditor = ({
  initial,
  onCancel,
  onSaved,
}: {
  initial: Editor
  onCancel: () => void
  onSaved: () => Promise<void>
}) => {
  const t = useTranslate()
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tested, setTested] = useState(false)
  const update = (change: Partial<Editor>) => {
    setValue((value) => ({ ...value, ...change }))
    setError('')
    setTested(false)
  }
  const submit = async (test: boolean) => {
    if (busy || !form.current?.reportValidity()) {
      return
    }
    setBusy(true)
    setError('')
    setTested(false)
    try {
      const response = await cloudFetch(
        `/mcp/servers/${value.id}${test ? '/test' : ''}`,
        cloudJson(test ? 'POST' : 'PUT', value)
      )
      const data = (await response.json()) as { server: McpServer }
      if (test) {
        setValue((value) => ({ ...value, tools: data.server.tools }))
        setTested(true)
      } else {
        await onSaved()
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const signIn = async () => {
    if (busy || !form.current?.reportValidity()) {
      return
    }
    setBusy(true)
    setError('')
    try {
      await redirectToOAuth(value)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }
  return (
    <form
      ref={form}
      action={`/api/mcp/servers/${value.id}`}
      method="post"
      aria-label={t('mcpConnection')}
      className={`${styles.card} ${styles.stack}`}
      onSubmit={(event) => {
        event.preventDefault()
        void submit(false)
      }}
    >
      <label htmlFor={`${id}-name`}>{t('mcpName')}</label>
      <input
        id={`${id}-name`}
        name="name"
        required
        maxLength={80}
        value={value.name}
        onChange={(event) => update({ name: event.target.value })}
        autoFocus
      />
      <label htmlFor={`${id}-url`}>{t('mcpUrl')}</label>
      <input
        id={`${id}-url`}
        name="url"
        type="url"
        required
        maxLength={2048}
        value={value.url}
        onChange={(event) =>
          update({
            url: event.target.value,
            ...(value.hasToken ? { hasToken: false, token: '' } : {}),
          })
        }
        placeholder="https://example.com/mcp"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={`${id}-help`}
      />
      <fieldset className={styles.tools}>
        <legend>{t('mcpAuthType')}</legend>
        {(['bearer', 'oauth'] as const).map((authType) => (
          <label key={authType} className={styles.check}>
            <input
              type="radio"
              name="authType"
              value={authType}
              checked={(value.authType ?? 'bearer') === authType}
              onChange={() => update({ authType, tools: [] })}
            />
            {t(authType === 'oauth' ? 'mcpAuthOAuth' : 'mcpAuthBearer')}
          </label>
        ))}
      </fieldset>
      {value.authType !== 'oauth' ? (
        <>
          <label htmlFor={`${id}-token`}>{t('mcpToken')}</label>
          <input
            id={`${id}-token`}
            name="token"
            type="password"
            autoComplete="new-password"
            maxLength={4096}
            value={value.token ?? ''}
            onChange={(event) => update({ token: event.target.value })}
            placeholder={t(
              value.hasToken && value.token === undefined ? 'mcpTokenStored' : 'mcpTokenOptional'
            )}
            aria-describedby={`${id}-help`}
          />
        </>
      ) : null}
      <p id={`${id}-help`} className={styles.description}>
        {t(value.authType === 'oauth' ? 'mcpOAuthHelp' : 'mcpTokenHelp')}
      </p>
      <label className={styles.check}>
        <input
          name="enabled"
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        {t('mcpEnableConnection')}
      </label>
      {value.tools.length ? (
        <fieldset className={styles.tools}>
          <legend>{t('mcpTools')}</legend>
          {value.tools.map((tool) => (
            <label key={tool.name} className={styles.check}>
              <input
                name="tools"
                type="checkbox"
                value={tool.name}
                checked={!value.disabledTools.includes(tool.name)}
                onChange={(event) =>
                  update({
                    disabledTools: event.target.checked
                      ? value.disabledTools.filter((name) => name !== tool.name)
                      : [...value.disabledTools, tool.name],
                  })
                }
              />
              <span>
                {tool.name}
                <span className={styles.toolDescription}>
                  {t(tool.readOnly ? 'mcpReadOnly' : 'mcpNeedsApproval')}
                  {tool.description ? ` · ${tool.description.slice(0, 150)}` : ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {tested ? <p role="status">{t('mcpTestSuccess', { count: value.tools.length })}</p> : null}
      <div className={styles.row}>
        {value.authType === 'oauth' ? (
          <Button type="button" size="m" disabled={busy} onClick={() => void signIn()}>
            {t(busy ? 'mcpConnecting' : 'mcpOAuthSignIn')}
          </Button>
        ) : null}
        <Button type="submit" size="m" disabled={busy}>
          {t(busy ? 'mcpConnecting' : 'mcpSave')}
        </Button>
        <Button
          type="button"
          variant="outlined"
          size="m"
          disabled={busy}
          onClick={() => void submit(true)}
        >
          {t('mcpTest')}
        </Button>
        <Button type="button" variant="outlined" size="m" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}
