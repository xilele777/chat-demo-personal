/** Text only: attachment uploads remain bound to the current page. */
export const draftStorageKey = (cloud: boolean) =>
  `chat-demo:draft-texts:${cloud ? 'cloud' : 'local'}`
export const activeSessionKey = (cloud: boolean) =>
  `chat-demo:active-session:${cloud ? 'cloud' : 'local'}`

export const readDraftTexts = (
  storage: Pick<Storage, 'getItem'>,
  cloud: boolean
): Map<string | null, string> => {
  const result = new Map<string | null, string>()
  try {
    const value: unknown = JSON.parse(storage.getItem(draftStorageKey(cloud)) ?? '[]')
    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          Array.isArray(item) &&
          item.length === 2 &&
          (item[0] === null || typeof item[0] === 'string') &&
          typeof item[1] === 'string' &&
          item[1]
        ) {
          result.set(item[0], item[1])
        }
      }
    }
  } catch {
    /* Invalid or unavailable storage must not prevent opening the app. */
  }
  return result
}

export const writeDraftTexts = (
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  cloud: boolean,
  drafts: Iterable<readonly [string | null, { text: string }]>
): boolean => {
  try {
    const texts = [...drafts]
      .filter(([, draft]) => draft.text)
      .map(([id, draft]) => [id, draft.text])
    if (texts.length) {
      storage.setItem(draftStorageKey(cloud), JSON.stringify(texts))
    } else {
      storage.removeItem(draftStorageKey(cloud))
    }
    return true
  } catch {
    return false
  }
}
