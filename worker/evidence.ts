/** Canonical source identity without changing meaningful query parameters. */
export const sourceUrl = (value: string): string => {
  const url = new URL(value)
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_|^(fbclid|gclid)$/i.test(key)) {
      url.searchParams.delete(key)
    }
  }
  return url.href
}

export const normalizedQuery = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

/** Select verbatim windows, not generated summaries, so dates and qualifications stay inspectable. */
export const evidenceExcerpt = (text: string, focus: string, maxCharacters: number): string => {
  if (text.length <= maxCharacters) {
    return text
  }
  const terms = new Set<string>()
  for (const word of normalizedQuery(focus).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) {
        terms.add(word.slice(i, i + 2))
      }
    } else if (word.length >= 3) {
      terms.add(word)
    }
  }
  const width = Math.max(80, Math.floor((maxCharacters - 212) / 3))
  const windows: { start: number; text: string; score: number }[] = []
  for (let start = 0; start < text.length; start += width) {
    // Overlap prevents a name or date at a boundary from being lost.
    const part = text.slice(Math.max(0, start - 60), start + width)
    const lower = part.toLowerCase()
    windows.push({
      start: Math.max(0, start - 60),
      text: part,
      score: [...terms].reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0),
    })
  }
  const ranked = windows.sort((a, b) => b.score - a.score || a.start - b.start)
  const selected = ranked
    .filter((part) => !ranked[0].score || part.score > 0)
    .slice(0, 3)
    .sort((a, b) => a.start - b.start)
  return selected
    .map((part) => part.text)
    .join('\n[… omitted …]\n')
    .slice(0, maxCharacters)
}
