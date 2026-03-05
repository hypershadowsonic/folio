import { useCallback, useEffect, useRef } from 'react'

/**
 * Returns a stable debounced version of `fn`.
 * The callback always calls the latest `fn` (via ref), so you don't need
 * to re-memoize callers when `fn` changes.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
): (...args: Args) => void {
  const fnRef      = useRef(fn)
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Always keep fnRef pointing at the latest fn without resetting the timer
  useEffect(() => { fnRef.current = fn })

  // Clear any pending timer on unmount
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return useCallback(
    (...args: Args) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => { fnRef.current(...args) }, delay)
    },
    [delay],
  )
}
