export type McpTool = { name: string; description: string; readOnly: boolean }
export type McpServer = {
  id: string
  name: string
  url: string
  enabled: boolean
  hasToken: boolean
  authType?: 'bearer' | 'oauth'
  oauthStatus?: 'authorized' | 'required'
  tools: McpTool[]
  disabledTools: string[]
  /** Owner-selected automatic reads; annotations alone grant no permission. */
  trustedReadTools?: string[]
  configurationRevision?: string
}
export type McpToolBlock = {
  type: 'mcp_tool'
  id: string
  server: string
  name: string
  input: Record<string, unknown>
  status: 'approval' | 'running' | 'done' | 'error' | 'denied' | 'unknown'
  approvalId?: string
  output?: string
}
