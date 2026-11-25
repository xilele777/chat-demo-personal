/** Evidence about one actual provider call, scoped to the generating answer/branch. */
export type ContextReport = {
  model: string
  round: number
  totalRounds: number
  retainedRounds: number
  omittedRounds: number
  firstRetainedRound: number
  estimatedInputTokens: number
  inputBudget: number
  outputBudget: number
  contextWindow: number | null
  retainedQuestionIds: string[]
}

export const validContextReport = (value: unknown): value is ContextReport => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const report = value as ContextReport
  const counts = [
    report.round,
    report.totalRounds,
    report.retainedRounds,
    report.omittedRounds,
    report.firstRetainedRound,
    report.estimatedInputTokens,
    report.inputBudget,
    report.outputBudget,
  ]
  return (
    typeof report.model === 'string' &&
    report.model.length <= 200 &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    report.totalRounds <= 2000 &&
    report.round <= 100 &&
    report.retainedRounds + report.omittedRounds === report.totalRounds &&
    report.firstRetainedRound === report.omittedRounds + 1 &&
    (report.contextWindow === null ||
      (Number.isSafeInteger(report.contextWindow) && report.contextWindow > 0)) &&
    Array.isArray(report.retainedQuestionIds) &&
    report.retainedQuestionIds.length <= 2000 &&
    report.retainedQuestionIds.every(
      (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id)
    )
  )
}
