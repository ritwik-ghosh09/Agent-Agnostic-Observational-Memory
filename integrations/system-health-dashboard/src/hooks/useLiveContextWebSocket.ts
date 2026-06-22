import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Live Context entry pushed by the dashboard over /api/live-context/ws.
 * Mirrors the entry shape produced by server.js handleLiveContextQuery.
 */
export interface LiveContextEntry {
  id: string
  query: string
  agent: string
  sessionId: string | null
  tmuxSession: string | null
  project: string | null
  cwd: string | null
  typedAt: string | null
  receivedAt: string
  /** Combined Working + Observational memory markdown ('' when retrieval failed). */
  markdown: string
  meta: {
    query?: string
    budget?: number
    results_count?: number
    tokens_used?: number
    working_memory_tokens?: number
    latency_ms?: number
  } | null
  error: string | null
}

interface WsMessage {
  type: string
  payload?: unknown
}

const API_PORT = process.env.SYSTEM_HEALTH_API_PORT || '3033'
const MAX_ENTRIES = 50

/** Build the WebSocket URL from the current page location (falls back to localhost). */
function getWsUrl(): string {
  if (typeof window === 'undefined') {
    return `ws://localhost:${API_PORT}/api/live-context/ws`
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname
  return `${protocol}//${host}:${API_PORT}/api/live-context/ws`
}

function httpBase(): string {
  if (typeof window === 'undefined') return `http://localhost:${API_PORT}`
  return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`
}

/**
 * Subscribe to the live memory-context feed. Connects to the dedicated WebSocket,
 * seeds from the REST history endpoint, and keeps a de-duplicated list of the most
 * recent entries (newest first). Auto-reconnects with linear backoff.
 */
export function useLiveContextWebSocket() {
  const [entries, setEntries] = useState<LiveContextEntry[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptsRef = useRef(0)
  const closedRef = useRef(false)

  const addEntry = useCallback((entry: LiveContextEntry) => {
    if (!entry || !entry.id) return
    setEntries((prev) => {
      if (prev.some((e) => e.id === entry.id)) return prev
      return [entry, ...prev].slice(0, MAX_ENTRIES)
    })
  }, [])

  const clear = useCallback(() => setEntries([]), [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    let ws: WebSocket
    try {
      ws = new WebSocket(getWsUrl())
    } catch {
      scheduleReconnect()
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      attemptsRef.current = 0
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage
        if (msg.type === 'LIVE_CONTEXT' && msg.payload) {
          addEntry(msg.payload as LiveContextEntry)
        }
      } catch {
        /* ignore malformed frames */
      }
    }

    ws.onclose = () => {
      setIsConnected(false)
      wsRef.current = null
      if (!closedRef.current) scheduleReconnect()
    }

    ws.onerror = () => {
      try { ws.close() } catch { /* noop */ }
    }
  }, [addEntry])

  const scheduleReconnect = useCallback(() => {
    if (closedRef.current) return
    attemptsRef.current += 1
    const delay = Math.min(1000 * attemptsRef.current, 10000)
    reconnectRef.current = setTimeout(() => connect(), delay)
  }, [connect])

  useEffect(() => {
    closedRef.current = false

    // Seed history so a freshly opened tab is not empty.
    fetch(`${httpBase()}/api/live-context?limit=${MAX_ENTRIES}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d: { data?: LiveContextEntry[] }) => {
        const seed = (d.data || []).slice().reverse() // newest first
        setEntries((prev) => {
          const ids = new Set(prev.map((e) => e.id))
          const merged = [...seed.filter((e) => !ids.has(e.id)), ...prev]
          return merged.slice(0, MAX_ENTRIES)
        })
      })
      .catch(() => { /* fail-open: live feed still works */ })

    connect()

    return () => {
      closedRef.current = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current) {
        try { wsRef.current.close() } catch { /* noop */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { entries, isConnected, clear }
}
