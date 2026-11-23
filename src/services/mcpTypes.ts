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
}
export type McpToolBlock = {
  type: 'mcp_tool'
  id: string
  server: string
  name: string
  input: Record<string, unknown>
  status: 'approval' | 'running' | 'done' | 'error' | 'denied'
  approvalId?: string
  output?: string
}
