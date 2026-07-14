import { createSlice, PayloadAction } from '@reduxjs/toolkit'

/**
 * Holds the row totals currently displayed by each tab so the NavBar badges
 * track the tab's SELECTED time range instead of a fixed window. Each page
 * publishes its range-scoped `total` on every fetch; the NavBar reads these.
 * `null` means "not yet reported by that page" — the NavBar falls back to its
 * own default-window fetch until the page reports.
 */
export interface TabCountsState {
  observations: number | null
  digests: number | null
  insights: number | null
}

const initialState: TabCountsState = {
  observations: null,
  digests: null,
  insights: null,
}

const tabCountsSlice = createSlice({
  name: 'tabCounts',
  initialState,
  reducers: {
    setObservationsCount(state, action: PayloadAction<number | null>) {
      state.observations = action.payload
    },
    setDigestsCount(state, action: PayloadAction<number | null>) {
      state.digests = action.payload
    },
    setInsightsCount(state, action: PayloadAction<number | null>) {
      state.insights = action.payload
    },
  },
})

export const { setObservationsCount, setDigestsCount, setInsightsCount } = tabCountsSlice.actions
export default tabCountsSlice.reducer
