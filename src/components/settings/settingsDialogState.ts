import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'
import { cloudMode, useCloud } from '../../services/cloud.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data' | 'models' | 'mcp'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
const callbackUrl = new URL(location.href)
const oauthResult = cloudMode ? callbackUrl.searchParams.get('mcp_oauth') : null
if (oauthResult) {
  callbackUrl.searchParams.delete('mcp_oauth')
  history.replaceState(history.state, '', callbackUrl.href)
}
export const useSettingsDialog = create(() => ({
  open: Boolean(oauthResult),
  section: (oauthResult ? 'mcp' : 'general') as SettingsSection,
  oauthResult,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false, oauthResult: null })

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (cloudMode && useCloud.getState().config?.configured) {
    return true
  }
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
