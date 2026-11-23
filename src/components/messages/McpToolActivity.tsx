import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { McpToolBlock } from '../../services/mcpTypes.js'
import { cloudFetch, cloudJson } from '../../services/cloud.js'
import { Button } from '../base/Button.js'
import styles from './McpToolActivity.module.css'

export const McpToolActivity = ({
  tools,
  streaming,
}: {
  tools: McpToolBlock[]
  streaming: boolean
}) => (
  <div className={styles.list}>
    {tools.map((tool) => (
      <Tool key={tool.id} tool={tool} streaming={streaming} />
    ))}
  </div>
)

const Tool = ({ tool, streaming }: { tool: McpToolBlock; streaming: boolean }) => {
  const t = useTranslate()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const interrupted = !streaming && (tool.status === 'approval' || tool.status === 'running')
  const status = interrupted
    ? t('mcpInterrupted')
    : t(
        tool.status === 'approval'
          ? 'mcpApproval'
          : tool.status === 'running'
            ? 'mcpRunning'
            : tool.status === 'done'
              ? 'mcpDone'
              : tool.status === 'denied'
                ? 'mcpDenied'
                : 'mcpError'
      )
  const decide = async (approved: boolean) => {
    setSending(true)
    setError('')
    try {
      await cloudFetch(`/mcp/approvals/${tool.approvalId}`, cloudJson('POST', { approved }))
      setSent(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <section className={styles.card} aria-label={`${tool.server}: ${tool.name}`}>
      <div className={styles.header}>
        <strong>
          {tool.server} · {tool.name}
        </strong>
        <span role="status">{status}</span>
      </div>
      <details open={tool.status === 'approval' && streaming}>
        <summary>{t('mcpDetails')}</summary>
        <pre>{JSON.stringify(tool.input, null, 2)}</pre>
        {tool.output ? <pre>{tool.output}</pre> : null}
      </details>
      {tool.status === 'approval' && streaming && tool.approvalId ? (
        <div className={styles.actions}>
          {sent ? (
            <span role="status">{t('mcpDecisionSent')}</span>
          ) : (
            <>
              <Button size="s" disabled={sending} onClick={() => void decide(true)}>
                {t('mcpAllow')}
              </Button>
              <Button
                size="s"
                variant="outlined"
                disabled={sending}
                onClick={() => void decide(false)}
              >
                {t('mcpDeny')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  )
}
