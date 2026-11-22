import { cloudMode } from '../cloud.js'
import * as local from './localDb.js'
import * as cloud from './cloudDb.js'

export type { StoredFile } from './localDb.js'
export const loadSessionSummaries = cloudMode
  ? cloud.loadSessionSummaries
  : local.loadSessionSummaries
export const loadSession = cloudMode ? cloud.loadSession : local.loadSession
export const saveSession = cloudMode ? cloud.saveSession : local.saveSession
export const renameSession = cloudMode ? cloud.renameSession : local.renameSession
export const deleteSession = cloudMode ? cloud.deleteSession : local.deleteSession
export const loadFile = cloudMode ? cloud.loadFile : local.loadFile
export const commitStaging = cloudMode ? cloud.commitStaging : local.commitStaging
export {
  saveFiles,
  clearStaging,
  addStagingSession,
  saveStagingFiles,
  updateStagingFileTypes,
  reportStorageError,
} from './localDb.js'
