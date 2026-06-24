import { useCallback, useEffect, useRef, useState } from 'react'
import { httpBase } from '@/hooks/useLiveContextWebSocket'

/** One tunable similarity group (Query↔Query or Query↔Item). */
export interface SimilaritySettings {
  /** Minimum cosine for admission (0.50–0.99). */
  threshold: number
  /** When true, weight = similarity^exponent; when false, linear (raw cosine). */
  exponentialEnabled: boolean
  /** Sharpness of the falloff (1.0–8.0); only used when exponentialEnabled. */
  exponent: number
}

/** Global, persisted retrieval scoring settings (mirrors retrieval-settings.js). */
export interface RetrievalSettings {
  queryQuery: SimilaritySettings
  queryItem: SimilaritySettings
}

/** Validation bounds — mirror src/retrieval/retrieval-settings.js. */
export const THRESHOLD_MIN = 0.5
export const THRESHOLD_MAX = 0.99
export const EXPONENT_MIN = 1.0
export const EXPONENT_MAX = 8.0

const DEFAULT_SETTINGS: RetrievalSettings = {
  queryQuery: { threshold: 0.85, exponentialEnabled: true, exponent: 3.0 },
  queryItem: { threshold: 0.7, exponentialEnabled: false, exponent: 3.0 },
}

type Group = keyof RetrievalSettings
type Field = keyof SimilaritySettings

/**
 * Load + persist the global retrieval scoring settings. GETs once on mount and
 * debounces PUTs so dragging a slider doesn't spam the server. Optimistically
 * updates local state, then persists and (optionally) triggers a live-preview
 * rerun so the dashboard re-tunes immediately.
 */
export function useRetrievalSettings(opts: { onSaved?: () => void } = {}) {
  const { onSaved } = opts
  const [settings, setSettings] = useState<RetrievalSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<RetrievalSettings | null>(null)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  // Initial load.
  useEffect(() => {
    let cancelled = false
    fetch(`${httpBase()}/api/retrieval-settings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: RetrievalSettings) => {
        if (!cancelled) setSettings(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'load failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const flush = useCallback(async () => {
    const body = pending.current
    if (!body) return
    pending.current = null
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${httpBase()}/api/retrieval-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const saved: RetrievalSettings = await res.json()
      setSettings(saved)
      onSavedRef.current?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }, [])

  const scheduleSave = useCallback(
    (next: RetrievalSettings) => {
      pending.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void flush()
      }, 400)
    },
    [flush]
  )

  const setField = useCallback(
    (group: Group, field: Field, value: number | boolean) => {
      setSettings((prev) => {
        const next: RetrievalSettings = {
          ...prev,
          [group]: { ...prev[group], [field]: value },
        }
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave]
  )

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  return { settings, loading, saving, error, setField }
}
