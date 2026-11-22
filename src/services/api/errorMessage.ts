/** Extract useful provider errors without rendering raw JSON or HTML in chat. */
export const providerErrorMessage = (message: string): string => {
  try {
    const value: unknown = JSON.parse(message)
    if (typeof value === 'object' && value !== null) {
      const error = 'error' in value ? value.error : value
      if (typeof error === 'string') {
        return error.slice(0, 1000)
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        return error.message.slice(0, 1000)
      }
    }
  } catch {
    // Plain-text provider errors are useful as-is; HTML gateway pages are not.
  }
  return /<\s*(?:!doctype|html|head|body)\b/i.test(message) ? '' : message.slice(0, 1000)
}
