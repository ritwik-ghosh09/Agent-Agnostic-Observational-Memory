import { Link, useLocation } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { useEffect, useState } from 'react'
import { ThemeToggle } from '@/components/theme-toggle'
import { useAppSelector } from '@/store'

const API_PORT = process.env.SYSTEM_HEALTH_API_PORT || '3033'
const API_BASE_URL = `http://localhost:${API_PORT}`

export function NavBar() {
  const location = useLocation()
  // Range-scoped totals published by each tab (null until that tab loads).
  // These are the source of truth so the badge matches what the tab shows for
  // its SELECTED time range.
  const reported = useAppSelector(s => s.tabCounts)
  // Fallback counts fetched here for tabs the user hasn't opened yet. Once a
  // tab publishes its own range-scoped total, that value takes precedence.
  const [obsFallback, setObsFallback] = useState<number | null>(null)
  const [digestFallback, setDigestFallback] = useState<number | null>(null)
  const [insightFallback, setInsightFallback] = useState<number | null>(null)

  useEffect(() => {
    // Mirror the pages' default 365-day window so the fallback badge matches
    // what a freshly-opened tab would show before the user narrows the range.
    const from = new Date()
    from.setDate(from.getDate() - 365)
    const fromStr = from.toISOString().split('T')[0]
    const toStr = new Date().toISOString().split('T')[0]
    const window = `from=${fromStr}&to=${toStr}`

    fetch(`${API_BASE_URL}/api/observations?limit=0&${window}`)
      .then(r => r.json())
      .then(d => setObsFallback(d.total ?? null))
      .catch(() => setObsFallback(null))

    fetch(`${API_BASE_URL}/api/digests?limit=0&${window}`)
      .then(r => r.json())
      .then(d => setDigestFallback(d.total ?? null))
      .catch(() => setDigestFallback(null))

    // Insights are NOT retention-pruned, so the SQLite-backed consolidation
    // status count matches the Insights tab directly.
    fetch(`${API_BASE_URL}/api/consolidation/status`)
      .then(r => r.json())
      .then(d => setInsightFallback(d.totalInsights ?? null))
      .catch(() => setInsightFallback(null))
  }, [location.pathname])

  // Prefer the tab-reported (range-scoped) total; fall back to the default-
  // window fetch for tabs not yet opened this session.
  const obsCount = reported.observations ?? obsFallback
  const digestCount = reported.digests ?? digestFallback
  const insightCount = reported.insights ?? insightFallback

  const tabs = [
    { label: 'Health', path: '/' },
    { label: 'Observations', path: '/observations', count: obsCount },
    { label: 'Digests', path: '/digests', count: digestCount },
    { label: 'Insights', path: '/insights', count: insightCount },
    { label: 'Coverage', path: '/coverage' },
    { label: 'Token Usage', path: '/token-usage' },
    { label: 'Live Context', path: '/live-context' },
  ]

  return (
    <nav className="border-b border-border px-6">
      <div className="flex items-center gap-6 h-12">
        {tabs.map(tab => {
          const isActive = location.pathname === tab.path ||
            (tab.path !== '/' && location.pathname.startsWith(tab.path))
          return (
            <Link
              key={tab.path}
              to={tab.path}
              className={`relative h-full flex items-center gap-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'text-foreground border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
              {tab.count != null && (
                <Badge variant="secondary" className="text-xs">
                  {tab.count}
                </Badge>
              )}
            </Link>
          )
        })}
        <ThemeToggle />
      </div>
    </nav>
  )
}
