import { create } from 'zustand'
export const useHistorySearch = create<{
  open: boolean
  jump: { sessionId: string; messageId: string; nonce: number } | null
}>(() => ({ open: false, jump: null }))
export const openHistorySearch = () => useHistorySearch.setState({ open: true })
export const closeHistorySearch = () => useHistorySearch.setState({ open: false })
