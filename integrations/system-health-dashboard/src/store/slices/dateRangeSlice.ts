import { createSlice, PayloadAction } from '@reduxjs/toolkit'

/**
 * Shared, persistent time-range for the Observations and Digests tabs.
 *
 * Lifting this out of each page's local state does two things the user asked
 * for:
 *  1. The chosen range survives tab switches (local state was re-initialised to
 *     defaults on every mount).
 *  2. Both tabs read the SAME range, so the Digests tab shows digests for the
 *     exact window selected on the Observations tab (and vice-versa).
 *
 * Defaults reach back ~365 days (just under ColdStoreReader's 366-day max) so
 * JSON cold-store history surfaces on first load.
 */
export interface DateRangeState {
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
}

function defaultFrom(): string {
  const d = new Date()
  d.setDate(d.getDate() - 365)
  return d.toISOString().split('T')[0]
}

function defaultTo(): string {
  return new Date().toISOString().split('T')[0]
}

const initialState: DateRangeState = {
  from: defaultFrom(),
  to: defaultTo(),
}

const dateRangeSlice = createSlice({
  name: 'dateRange',
  initialState,
  reducers: {
    setFrom(state, action: PayloadAction<string>) {
      state.from = action.payload
    },
    setTo(state, action: PayloadAction<string>) {
      state.to = action.payload
    },
    setRange(state, action: PayloadAction<DateRangeState>) {
      state.from = action.payload.from
      state.to = action.payload.to
    },
  },
})

export const { setFrom, setTo, setRange } = dateRangeSlice.actions
export default dateRangeSlice.reducer
