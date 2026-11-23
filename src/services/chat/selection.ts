import { create } from 'zustand'

/** Ephemeral list selection; navigation clears it without affecting conversation data. */
export const useSessionSelection = create<{ multi: boolean; selected: Set<string> }>(() => ({
  multi: false,
  selected: new Set(),
}))

export const clearSessionSelection = () =>
  useSessionSelection.setState({ multi: false, selected: new Set() })
