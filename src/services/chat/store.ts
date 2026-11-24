import { create } from 'zustand'
import { clearSessionSelection } from './selection.js'
import { cloudMode, cloudFetch, cloudJson, useCloud } from '../cloud.js'
import * as cloudDb from './cloudDb.js'
import * as localDb from './localDb.js'
import { translate } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { ChatModel, CreateMessageRequest } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import {
  cancelUpload,
  checkImageFileIds,
  describeUploadError,
  uploadAttachment,
  useUploads,
} from '../attachments.js'
import { useSettings } from '../settings.js'
import {
  appendBranch,
  getVisibleMessages,
  normalizeSession,
  selectVersion,
  revealMessage,
} from './branches.js'
import { activeSessionKey } from './draftStorage.js'
import { selectedModel, modelReasoningEfforts } from '../models.js'
import { addUsage } from './usage.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getReplyText,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 10
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  sessionSaving: Record<string, boolean>
  sessionSavedAt: Record<string, number>
  sessionSaveDetails: Record<string, { message: string; status?: number }>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  sessionSaving: {},
  sessionSavedAt: {},
  sessionSaveDetails: {},
}))

// Keep the last destination so reopening the page also reopens its text draft.
useChatStore.subscribe((state, previous) => {
  if (state.activeId !== previous.activeId) {
    try {
      localStorage.setItem(activeSessionKey(cloudMode), state.activeId ?? '')
    } catch {
      /* Keep navigation working without storage. */
    }
  }
})

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  Boolean(a.pinned) === Boolean(b.pinned)

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const saveAttempts = new Map<string, number>()
const sessionLoads = new Map<string, { promise: Promise<void> }>()
/** Only explicit local metadata edits may override a freshly fetched detail. */
const pendingMetadata = new Map<
  string,
  Partial<Pick<Session, 'title' | 'titleSource' | 'pinned'>>
>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const attempt = (saveAttempts.get(sessionId) ?? 0) + 1
    saveAttempts.set(sessionId, attempt)
    set((state) => ({ sessionSaving: { ...state.sessionSaving, [sessionId]: true } }))
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
            sessionSavedAt: { ...state.sessionSavedAt, [sessionId]: Date.now() },
            sessionSaveDetails: Object.fromEntries(
              Object.entries(state.sessionSaveDetails).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          if (saveAttempts.get(sessionId) !== attempt) {
            return
          }
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
            sessionSaveDetails: {
              ...state.sessionSaveDetails,
              [sessionId]: {
                message: error instanceof Error ? error.message : String(error),
                ...((error as { status?: number })?.status
                  ? { status: (error as { status: number }).status }
                  : {}),
              },
            },
          }))
        }
      })
      .finally(() => {
        if (epoch === historyEpoch && saveAttempts.get(sessionId) === attempt) {
          set((state) => ({ sessionSaving: { ...state.sessionSaving, [sessionId]: false } }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach((id) => {
      if (getSession(id)) {
        persist(id)
      } else if (cloudMode) {
        void ensureSessionLoaded(id).then(() => persist(id))
      }
    })
  }
}

/** Refresh only when local work is saved. Recheck identities after I/O so a late
 * response cannot replace edits or a generation started while the request ran. */
export const syncCloudSessions = async (): Promise<void> => {
  if (
    !cloudMode ||
    !get().ready ||
    useCloud.getState().syncing ||
    get().importingHistory ||
    unsavedSessions.size ||
    cloudDb.pendingIds().length ||
    sessionLoads.size ||
    Object.keys(get().streaming).length
  ) {
    return
  }
  const before = get()
  useCloud.setState({ syncing: true })
  const unchanged = () =>
    get().sessionCache === before.sessionCache &&
    get().sessions === before.sessions &&
    get().activeId === before.activeId &&
    !get().importingHistory &&
    !unsavedSessions.size &&
    !sessionLoads.size &&
    !Object.keys(get().streaming).length
  try {
    const index = await cloudDb.readIndex()
    if (!unchanged()) {
      return
    }
    const remote = new Map(index.sessions.map((session) => [session.id, session]))
    const retained = Object.fromEntries(
      Object.entries(before.sessionCache).filter(([id, session]) => {
        const summary = remote.get(id)
        return summary && cloudDb.isSessionCurrent(session, index.generation, summary.revision)
      })
    )
    const active =
      before.activeId && remote.has(before.activeId)
        ? (retained[before.activeId] ??
          (await cloudDb
            .loadSession(before.activeId)
            .then((session) =>
              session ? settleInterrupted(normalizeSession(session)) : undefined
            )))
        : undefined
    if (!unchanged()) {
      return
    }
    if (active) {
      retained[active.id] = active
    }
    const summaries = sortSessions(index.sessions.map(toSessionSummary))
    const sameList =
      summaries.length === before.sessions.length &&
      summaries.every(
        (summary, i) =>
          summary.id === before.sessions[i].id && sameSummary(summary, before.sessions[i])
      )
    const sameCache =
      Object.keys(retained).length === Object.keys(before.sessionCache).length &&
      Object.entries(retained).every(([id, session]) => session === before.sessionCache[id])
    // 只淘汰已修改或已删除的详情，未变化的对话和对象引用继续复用。
    set({
      sessions: sameList ? before.sessions : summaries,
      sessionCache: sameCache ? before.sessionCache : retained,
      activeId: active?.id ?? null,
      sessionLoadErrors: {},
    })
    trimSessionCache()
    useCloud.setState({ error: null, lastSyncedAt: Date.now() })
  } catch (error) {
    useCloud.setState({ error: error instanceof Error ? error.message : 'Sync failed' })
  } finally {
    useCloud.setState({ syncing: false })
  }
}

export const bindCloudSync = () => {
  if (!cloudMode) {
    return () => {}
  }
  const refresh = () => {
    if (document.visibilityState === 'visible') {
      void syncCloudSessions()
    }
  }
  const timer = setInterval(refresh, 15_000)
  window.addEventListener('focus', refresh)
  window.addEventListener('online', refresh)
  document.addEventListener('visibilitychange', refresh)
  return () => {
    clearInterval(timer)
    window.removeEventListener('focus', refresh)
    window.removeEventListener('online', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
}

/** Preserve unsynced edits under fresh IDs before replacing the visible cache. */
export const keepCopiesAndSync = async (): Promise<void> => {
  if (!cloudMode || get().importingHistory || Object.keys(get().streaming).length) {
    return
  }
  set({ importingHistory: true })
  try {
    await cloudDb.readIndex()
    const ids = [...new Set([...unsavedSessions, ...cloudDb.pendingIds()])]
    for (const id of ids) {
      const session = getSession(id) ?? (await cloudDb.loadSession(id))
      if (!session) {
        continue
      }
      const copy: Session = {
        ...session,
        id: createId(),
        cloud: cloudDb.newStamp(),
        title: `${session.title || translate('untitledChat')} (${translate('cloudLocalCopy')})`,
        updatedAt: Date.now(),
      }
      await db.saveSession(copy, pendingFiles.get(id))
    }
    await cloudDb.forgetPending(ids)
    ids.forEach((id) => {
      unsavedSessions.delete(id)
      pendingFiles.delete(id)
    })
    set({ sessionCache: {}, sessionSaveErrors: {}, activeId: null })
  } catch (error) {
    useCloud.setState({ error: error instanceof Error ? error.message : 'Sync failed' })
  } finally {
    set({ importingHistory: false })
  }
  await syncCloudSessions()
}

/** Explicitly migrate this origin's pre-cloud IndexedDB sessions as new cloud copies. */
export const uploadLocalHistory = async (): Promise<number> => {
  if (
    !cloudMode ||
    get().importingHistory ||
    Object.keys(get().streaming).length ||
    unsavedSessions.size
  ) {
    throw new Error(translate('cloudWaitForSave'))
  }
  set({ importingHistory: true })
  let count = 0
  try {
    await cloudDb.readIndex()
    for (const summary of await localDb.loadSessionSummaries()) {
      const session = await localDb.loadSession(summary.id)
      if (!session) {
        continue
      }
      await db.saveSession({
        ...settleInterrupted(normalizeSession(session)),
        id: createId(),
        cloud: cloudDb.newStamp(),
      })
      count++
    }
    return count
  } finally {
    set({ importingHistory: false })
    await syncCloudSessions()
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  const config = useCloud.getState().config
  const model = cloudMode ? selectedModel() : MODEL
  const effort = useSettings.getState().reasoningEffort
  const reasoningRequested =
    cloudMode &&
    config?.protocol === 'openai' &&
    effort !== 'none' &&
    modelReasoningEfforts(model, config.reasoningEfforts, config.reasoningEffortsAutomatic).length >
      0
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model,
    reasoningEffort: useSettings.getState().reasoningEffort,
    thinking: reasoningRequested || (thinking && (!cloudMode || Boolean(config?.thinking))),
    search: search && (!cloudMode || Boolean(useCloud.getState().config?.search)),
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        if (cloudMode) {
          for (const id of cloudDb.pendingIds()) {
            unsavedSessions.add(id)
          }
        }
        set({ ready: true, sessions: sortSessions(summaries) })
        try {
          const previousId = localStorage.getItem(activeSessionKey(cloudMode))
          if (
            previousId &&
            get().activeId === null &&
            summaries.some((session) => session.id === previousId)
          ) {
            selectSession(previousId)
          }
        } catch {
          /* No last-session state available. */
        }
        if (cloudMode) {
          // 先绘制列表，再低优先级预热最近两条；不一次下载全部历史。
          setTimeout(() => {
            if (epoch === historyEpoch) {
              get()
                .sessions.slice(0, 2)
                .forEach((session) => prefetchSession(session.id))
            }
          }, 150)
        }
        if (cloudMode && unsavedSessions.size) {
          set({
            sessionSaveErrors: Object.fromEntries([...unsavedSessions].map((id) => [id, true])),
          })
        }
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string, prefetch = false): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = cloudMode ? await cloudDb.loadSession(id, prefetch) : await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // The list can be older than this detail after another device saves. Preserve
      // remote metadata unless the owner explicitly edited it locally while unloaded.
      const edits = pendingMetadata.get(id)
      const session = edits ? { ...settled, ...edits } : settled
      pendingMetadata.delete(id)
      touchSession(id)
      set((state) => ({
        sessionCache: { ...state.sessionCache, [id]: session },
        sessions: sortSessions(
          state.sessions.map((item) => (item.id === id ? toSessionSummary(session) : item))
        ),
      }))
      if (session !== stored || (cloudMode && cloudDb.pendingIds().includes(id))) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    pendingMetadata.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      sessionSaving: {},
      sessionSavedAt: {},
      sessionSaveDetails: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    clearSessionSelection()
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    clearSessionSelection()
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const revealSessionMessage = async (
  sessionId: string,
  messageId: string | null,
  signal?: AbortSignal
): Promise<boolean> => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    !get().sessions.some((session) => session.id === sessionId)
  ) {
    return false
  }
  await ensureSessionLoaded(sessionId)
  if (
    signal?.aborted ||
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    !get().sessions.some((session) => session.id === sessionId)
  ) {
    return false
  }
  const session = getSession(sessionId)
  if (!session) {
    return false
  }
  if (!messageId) {
    selectSession(sessionId)
    return true
  }
  if (!session.messages.some((message) => message.id === messageId)) {
    return false
  }
  if (!getVisibleMessages(session).some((message) => message.id === messageId)) {
    if (getStreamController(sessionId)) {
      return false
    }
    updateSession(sessionId, (session) => revealMessage(session, messageId))
    persist(sessionId)
  }
  selectSession(sessionId)
  return true
}

/** 预加载与点击共用读取任务；不切换当前对话，并限制后台并发。 */
export const prefetchSession = (id: string) => {
  if (
    get().ready &&
    !get().importingHistory &&
    !getSession(id) &&
    sessionLoads.size < 2 &&
    get().sessions.some((session) => session.id === id)
  ) {
    void ensureSessionLoaded(id, true)
  }
}

export const setSessionPinned = (id: string, pinned: boolean) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, pinned }))
    persist(id)
  } else {
    pendingMetadata.set(id, { ...pendingMetadata.get(id), pinned })
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, pinned } : session
      ),
    }))
    // Loading merges the newest list metadata before saving, including edits made during loading.
    void ensureSessionLoaded(id)
  }
}

const manuallyNamedSessions = new Set<string>()
const generatingTitles = new Set<string>()

export const renameSession = (id: string, title: string) => {
  manuallyNamedSessions.add(id)
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title, titleSource: 'manual' }))
    persist(id)
  } else {
    pendingMetadata.set(id, { ...pendingMetadata.get(id), title, titleSource: 'manual' })
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    if (cloudMode) {
      // Loading merges the just-edited list title into the detail, then persists it.
      void ensureSessionLoaded(id)
    } else {
      void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
    }
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    pendingMetadata.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      ...(cloudMode ? { cloud: cloudDb.newStamp() } : {}),
      id: createId(),
      title:
        cloudMode && useCloud.getState().config?.protocol !== 'deepseek'
          ? (text || files[0]?.name || '').slice(0, 60)
          : '',
      ...(cloudMode && useCloud.getState().config?.protocol !== 'deepseek'
        ? { titleSource: 'pending' as const }
        : {}),
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      // 草稿附件已上传成功，每张图片都在上传前检查过长边，超限的已缩小。
      imageSizeChecked: isImage,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? (cloudMode ? selectedModel() : MODEL),
    thinking: previous.thinking ?? thinking,
    reasoningEffort: previous.reasoningEffort ?? useSettings.getState().reasoningEffort,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/**
 * 将 serverId 写回所有引用同一附件的消息。传入 null 会清除超限旧图的 ID，触发补传。
 * 尺寸标记随有效 ID 保存，因为本地保留的是原图，刷新后可以直接复用已检查的上传副本。
 */
const saveServerIds = (sessionId: string, serverIds: ReadonlyMap<string, string | null>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const serverId = serverIds.get(file.id)
              return serverId === undefined
                ? file
                : { ...file, serverId, imageSizeChecked: file.isImage && serverId !== null }
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  // 旧图片超限时先清除 ID，交给下方已有的附件补传流程。
  const files = [
    ...request.question.files,
    ...getContextRounds(request.history).flatMap(([user]) => user.files),
  ]
  const checked = await Promise.race([checkImageFileIds(files, signal), aborted])
  if (checked.size > 0) {
    saveServerIds(sessionId, checked)
    request = refreshRequest(sessionId, request)
  }
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId && serverId !== file.serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

const generateSessionTitle = async (
  sessionId: string,
  question: UserMessage,
  reply: AssistantMessage
) => {
  const session = getSession(sessionId)
  const epoch = historyEpoch
  if (
    !cloudMode ||
    session?.titleSource !== 'pending' ||
    generatingTitles.has(sessionId) ||
    manuallyNamedSessions.has(sessionId) ||
    reply.status !== 'done' ||
    reply.stopReason === 'refusal' ||
    !getReplyText(reply).trim()
  ) {
    return
  }
  generatingTitles.add(sessionId)
  try {
    const result = (await (
      await cloudFetch(
        '/title',
        cloudJson('POST', {
          question: question.content || question.files.map((file) => file.name).join(', '),
          answer: getReplyText(reply),
        })
      )
    ).json()) as { title: string }
    if (
      epoch !== historyEpoch ||
      deletingSessions.has(sessionId) ||
      manuallyNamedSessions.has(sessionId) ||
      getSession(sessionId)?.titleSource !== 'pending' ||
      getSession(sessionId)?.title !== session.title ||
      typeof result.title !== 'string' ||
      !result.title.trim()
    ) {
      return
    }
    updateSession(sessionId, (current) => ({
      ...current,
      title: result.title.trim().slice(0, 60),
      titleSource: 'generated',
    }))
    persist(sessionId)
  } catch {
    // Keep the provisional title. A later successful reply can retry without interrupting the answer.
  } finally {
    generatingTitles.delete(sessionId)
  }
}

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = { ...initial, usage: undefined } as AssistantMessage
  let processingStart = 0
  const previousProcessingSeconds = request.prefix?.processingSeconds ?? 0
  const processingNow = () =>
    processingStart
      ? previousProcessingSeconds + Math.max(0, (performance.now() - processingStart) / 1000)
      : previousProcessingSeconds
  const visibleReply = () => ({ ...reply, usage: addUsage(request.prefix?.usage, reply.usage) })
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, visibleReply())
  }
  streamFlushes.set(sessionId, flush)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, visibleReply())
        persist(sessionId)
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          cloudMode && useCloud.getState().config?.protocol !== 'deepseek'
        )
        processingStart = performance.now()
        const requestStartedAt = Date.now()
        reply = {
          ...reply,
          processingStartedAt: requestStartedAt,
          processingSeconds: previousProcessingSeconds,
        }
        const events = streamMessage(
          useSettings.getState().apiKey ?? '',
          {
            model: initial.model ?? MODEL,
            system:
              cloudMode && useCloud.getState().config?.protocol !== 'deepseek'
                ? 'You are a helpful assistant.'
                : SYSTEM_PROMPT,
            messages,
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            ...(cloudMode &&
            useCloud.getState().config?.protocol === 'openai' &&
            initial.reasoningEffort &&
            initial.reasoningEffort !== 'auto' &&
            modelReasoningEfforts(
              initial.model ?? selectedModel(),
              useCloud.getState().config?.reasoningEfforts,
              useCloud.getState().config?.reasoningEffortsAutomatic
            ).includes(initial.reasoningEffort)
              ? { reasoning_effort: initial.reasoningEffort }
              : {}),
            safety_check: SAFETY_CHECK,
            tools: serverTools(initial.search ?? false),
            ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
          },
          controller.signal
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          // Derive stream timestamps from a monotonic clock so wall-clock corrections cannot distort durations.
          reply = applyEvent(
            reply,
            event,
            requestStartedAt + performance.now() - processingStart,
            blockIndexes
          )
          if (event.type === 'message_delta' && event.usage && !event.delta.stop_reason) {
            // A completed tool stage must survive cancellation or closing the page during the next stage.
            flush()
            persist(sessionId)
          } else if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    if (processingStart) {
      reply = { ...reply, processingSeconds: processingNow(), processingStartedAt: undefined }
    }
    const finalReply = visibleReply()
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, finalReply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
    void generateSessionTitle(sessionId, request.question, finalReply)
  }
}
