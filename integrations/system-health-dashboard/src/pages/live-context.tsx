import { Fragment, useEffect, useMemo, useState } from 'react'
import { httpBase, useLiveContextWebSocket } from '@/hooks/useLiveContextWebSocket'
import type {
  LiveContextEntry,
  LiveContextRerankRequest,
  LiveContextRerankResponse,
  LiveSubmitted,
  RankedResult,
} from '@/hooks/useLiveContextWebSocket'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { RetrievalTuningPanel } from '@/components/RetrievalTuningPanel'
import {
  Brain,
  Database,
  Radio,
  Terminal,
  AlertTriangle,
  Send,
  Loader2,
  ListOrdered,
  ChevronUp,
  ChevronDown,
} from 'lucide-react'

const WORKING_HEADERS = ['Working Memory', 'Previous Session']
const OBSERVATIONAL_HEADERS = ['Observational Memory', 'Insights', 'Digests', 'Entities', 'Observations']

interface MdSection {
  title: string
  body: string
}

/** Split combined retrieval markdown into `## `-delimited sections. */
function splitSections(markdown: string): MdSection[] {
  if (!markdown) return []
  const sections: MdSection[] = []
  const lines = markdown.split('\n')
  let current: MdSection | null = null
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/)
    if (m) {
      if (current) sections.push(current)
      current = { title: m[1].trim(), body: '' }
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    } else {
      // Content before any header → bucket under a generic heading.
      current = { title: 'Context', body: line }
    }
  }
  if (current) sections.push(current)
  return sections.filter((s) => s.body.trim().length > 0 || WORKING_HEADERS.includes(s.title))
}

/** Render inline markdown: `code`, **bold**, and bare text. Safe (no HTML injection). */
function renderInline(text: string, keyPrefix: string) {
  const nodes: React.ReactNode[] = []
  // Tokenise on backtick code spans first.
  const parts = text.split(/(`[^`]+`)/g)
  parts.forEach((part, i) => {
    if (/^`[^`]+`$/.test(part)) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {part.slice(1, -1)}
        </code>
      )
      return
    }
    // Bold within the remaining text.
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
    boldParts.forEach((bp, j) => {
      if (/^\*\*[^*]+\*\*$/.test(bp)) {
        nodes.push(<strong key={`${keyPrefix}-b${i}-${j}`}>{bp.slice(2, -2)}</strong>)
      } else if (bp) {
        nodes.push(<Fragment key={`${keyPrefix}-t${i}-${j}`}>{bp}</Fragment>)
      }
    })
  })
  return nodes
}

/** Minimal, dependency-free markdown body renderer (headings, bullets, paragraphs). */
function MarkdownBody({ body }: { body: string }) {
  const lines = body.split('\n')
  return (
    <div className="space-y-1 text-sm leading-relaxed text-foreground/90">
      {lines.map((line, idx) => {
        const trimmed = line.trim()
        if (!trimmed) return <div key={idx} className="h-1" />
        const h3 = trimmed.match(/^###\s+(.*)$/)
        if (h3) {
          return (
            <div key={idx} className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {renderInline(h3[1], `h3-${idx}`)}
            </div>
          )
        }
        const bullet = trimmed.match(/^[-*]\s+(.*)$/)
        if (bullet) {
          return (
            <div key={idx} className="flex gap-2 pl-1">
              <span className="select-none text-muted-foreground">•</span>
              <span>{renderInline(bullet[1], `li-${idx}`)}</span>
            </div>
          )
        }
        return <div key={idx}>{renderInline(trimmed, `p-${idx}`)}</div>
      })}
    </div>
  )
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const secs = Math.round((Date.now() - t) / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  return `${hrs}h ago`
}

const AGENT_COLORS: Record<string, string> = {
  copilot: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  claude: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  opencode: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
}

const TIER_COLORS: Record<RankedResult['tier'], string> = {
  insights: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  digests: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  kg_entities: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
  observations: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
}

const TIER_LABELS: Record<RankedResult['tier'], string> = {
  insights: 'insights',
  digests: 'digests',
  kg_entities: 'entities',
  observations: 'observations',
}

function MemoryColumn({
  icon,
  title,
  sections,
  empty,
  accent,
}: {
  icon: React.ReactNode
  title: string
  sections: MdSection[]
  empty: string
  accent: string
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className={accent}>{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {sections.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">{empty}</p>
        ) : (
          <div className="space-y-4">
            {sections.map((s) => (
              <div key={s.title}>
                {s.title !== title && (
                  <div className="mb-1 text-sm font-semibold">{s.title}</div>
                )}
                <MarkdownBody body={s.body} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Two-column Working / Observational memory for the live query's retrieval. */
function MemoryColumns({ entry, typing }: { entry: LiveContextEntry | null; typing: boolean }) {
  const sections = entry ? splitSections(entry.markdown) : []
  const working = sections.filter((s) => WORKING_HEADERS.includes(s.title))
  const observational = sections.filter((s) => OBSERVATIONAL_HEADERS.includes(s.title))
  const other = sections.filter(
    (s) => !WORKING_HEADERS.includes(s.title) && !OBSERVATIONAL_HEADERS.includes(s.title)
  )

  const emptyFor = (kind: 'working' | 'observational') => {
    if (typing) return 'Retrieving after you pause…'
    if (!entry) return 'Start typing a prompt in the CLI to preview its memory.'
    return kind === 'working'
      ? 'No working-memory context for this query.'
      : 'No observational matches for this query.'
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <MemoryColumn
        icon={<Brain className="h-4 w-4" />}
        title="Working Memory"
        accent="text-violet-500"
        sections={typing ? [] : working}
        empty={emptyFor('working')}
      />
      <MemoryColumn
        icon={<Database className="h-4 w-4" />}
        title="Observational Memory"
        accent="text-sky-500"
        sections={typing ? [] : observational.length ? observational : other}
        empty={emptyFor('observational')}
      />
    </div>
  )
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(3) : '—'
}

function resultItemKey(result: RankedResult): string {
  return `${result.tier}:${result.id}`
}

type SaveStatus =
  | { kind: 'idle'; message: string | null }
  | { kind: 'saving'; message: string }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }

/** Small "OM" pill marking a ranked item that populated the Observational Memory preview. */
function ObservationalPill() {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            aria-label="Used in Observational Memory"
            className="cursor-default border-emerald-500/40 bg-emerald-500/10 px-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
          >
            OM
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">
          Used to populate the Observational Memory preview for this query.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Ranked sidebar containing every retrieval candidate for the live query. */
function RankedResultsSidebar({ entry }: { entry: LiveContextEntry | null }) {
  const original = useMemo(
    () => (entry?.rankedResults ?? []).slice().sort((a, b) => a.rank - b.rank),
    [entry]
  )
  const [ordered, setOrdered] = useState<RankedResult[]>(original)
  const [baselineKeys, setBaselineKeys] = useState<string[]>(original.map(resultItemKey))
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle', message: null })

  useEffect(() => {
    setOrdered(original)
    setBaselineKeys(original.map(resultItemKey))
    setSaveStatus({ kind: 'idle', message: null })
  }, [entry?.id, original])

  const orderedKeys = ordered.map(resultItemKey)
  const isModified =
    orderedKeys.length === baselineKeys.length && orderedKeys.some((key, index) => key !== baselineKeys[index])
  const isSaving = saveStatus.kind === 'saving'

  const moveResult = (fromIndex: number, direction: -1 | 1) => {
    const toIndex = fromIndex + direction
    if (toIndex < 0 || toIndex >= ordered.length || isSaving) return
    setOrdered((current) => {
      const next = current.slice()
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
    setSaveStatus({ kind: 'idle', message: null })
  }

  const resetOrder = () => {
    const byKey = new Map(original.map((result) => [resultItemKey(result), result]))
    const reset = baselineKeys.map((key) => byKey.get(key)).filter((result): result is RankedResult => Boolean(result))
    setOrdered(reset.length === original.length ? reset : original)
    setSaveStatus({ kind: 'idle', message: null })
  }

  const saveRanking = async () => {
    if (!entry || !isModified || isSaving) return
    const queryText = entry.query || entry.meta?.query || ''
    if (!queryText.trim()) {
      setSaveStatus({ kind: 'error', message: 'Cannot save ranking without a query.' })
      return
    }

    const request: LiveContextRerankRequest = {
      schemaVersion: 1,
      liveContextEntryId: entry.id,
      queryText,
      context: {
        agent: entry.agent,
        project: entry.project,
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        tmuxSession: entry.tmuxSession,
      },
      originalRanking: original.map((result, index) => ({
        itemKey: resultItemKey(result),
        id: result.id,
        tier: result.tier,
        originalRank: result.rank || index + 1,
        rawScore: result.rawScore,
        rrfScore: result.rrfScore,
        tierWeight: result.tierWeight,
        title: result.title,
        snippet: result.snippet,
      })),
      humanRanking: ordered.map((result, index) => ({
        itemKey: resultItemKey(result),
        humanRank: index + 1,
      })),
      capturedAt: new Date().toISOString(),
      source: 'dashboard-live-context',
    }

    setSaveStatus({ kind: 'saving', message: 'Saving ranking…' })
    try {
      const response = await fetch(`${httpBase()}/api/live-context/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const payload = (await response.json().catch(() => ({}))) as Partial<LiveContextRerankResponse>
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Save failed (${response.status})`)
      }
      setBaselineKeys(orderedKeys)
      setSaveStatus({
        kind: 'success',
        message: payload.eventId ? `Ranking saved (${payload.eventId.slice(0, 8)}).` : 'Ranking saved.',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save ranking.'
      setSaveStatus({ kind: 'error', message })
    }
  }

  return (
    <Card className="flex min-h-[28rem] flex-col overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <ListOrdered className="h-3.5 w-3.5 text-primary" /> All Results
            {isModified && <Badge variant="outline" className="text-[10px] normal-case">modified</Badge>}
          </span>
          <Badge variant="outline">{original.length}</Badge>
        </CardTitle>
        {isModified && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Human order has unsaved changes.</span>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" onClick={resetOrder} disabled={isSaving}>
                Reset
              </Button>
              <Button size="sm" onClick={saveRanking} disabled={isSaving}>
                {isSaving ? 'Saving…' : 'Save ranking'}
              </Button>
            </div>
          </div>
        )}
        {saveStatus.message && (
          <div
            className={`mt-2 text-[11px] ${
              saveStatus.kind === 'error'
                ? 'text-destructive'
                : saveStatus.kind === 'success'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-muted-foreground'
            }`}
          >
            {saveStatus.message}
          </div>
        )}
      </CardHeader>
      <ScrollArea className="flex-1">
        <div className="space-y-2 p-2">
          {ordered.length === 0 ? (
            <p className="px-2 py-3 text-xs italic text-muted-foreground">
              {entry ? 'No results for this query.' : 'No results yet.'}
            </p>
          ) : (
            ordered.map((result, index) => (
              <div key={resultItemKey(result)} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 w-7 shrink-0 text-xs font-semibold text-muted-foreground">
                    #{index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Badge className={TIER_COLORS[result.tier]}>{TIER_LABELS[result.tier]}</Badge>
                      {result.usedInObservational && <ObservationalPill />}
                      <span className="truncate font-medium text-foreground/90">{result.title}</span>
                    </div>
                    <p className="mt-1 max-h-10 overflow-hidden text-xs leading-5 text-muted-foreground">
                      {result.snippet}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-[10px] uppercase text-muted-foreground/70">
                      <span>score {formatScore(result.rawScore)}</span>
                      <span>rrf {formatScore(result.rrfScore)}</span>
                      {index + 1 !== result.rank && <span>was #{result.rank}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => moveResult(index, -1)}
                      disabled={index === 0 || isSaving}
                      aria-label={`Move result ${index + 1} up`}
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => moveResult(index, 1)}
                      disabled={index === ordered.length - 1 || isSaving}
                      aria-label={`Move result ${index + 1} down`}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </Card>
  )
}

/** Main heading bar — streams the prompt the user is typing in the CLI. */
function HeadingCard({
  query,
  context,
  agent,
  project,
  isTyping,
  latencyMs,
  resultsCount,
}: {
  query: string
  context: string
  agent: string
  project: string | null
  isTyping: boolean
  latencyMs: number | null
  resultsCount: number | null
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {agent && <Badge className={AGENT_COLORS[agent] || 'bg-muted'}>{agent}</Badge>}
          {project && (
            <span className="flex items-center gap-1">
              <Terminal className="h-3 w-3" /> {project}
            </span>
          )}
          <Badge
            variant="outline"
            className={
              isTyping ? 'border-amber-500 text-amber-600' : 'border-emerald-500 text-emerald-600'
            }
          >
            {isTyping ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> typing…
              </>
            ) : (
              'retrieved'
            )}
          </Badge>
          {!isTyping && latencyMs != null && <span>{latencyMs}ms</span>}
          {!isTyping && resultsCount != null && <span>{resultsCount} results</span>}
        </div>
        <div className="mt-2 text-lg font-medium">
          <span className="text-muted-foreground">❯ </span>
          {query || <span className="italic text-muted-foreground">Waiting for typing…</span>}
        </div>
        {context && (
          <div className="mt-1 text-xs text-muted-foreground/80 break-words">
            <span className="font-medium">context:</span> {context}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Left sidebar — a read-only log of queries actually submitted to the CLI. */
function RecentQueries({ items }: { items: LiveSubmitted[] }) {
  return (
    <Card className="hidden flex-col overflow-hidden md:flex">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Send className="h-3.5 w-3.5" /> Recent Queries
        </CardTitle>
      </CardHeader>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {items.length === 0 ? (
            <p className="px-2 py-3 text-xs italic text-muted-foreground">
              No submitted queries yet. Press Enter in the CLI to log one here.
            </p>
          ) : (
            items.map((e) => (
              <div key={e.id} className="rounded-md px-3 py-2 text-left text-sm">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="truncate text-foreground/90">{e.query}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] uppercase text-muted-foreground/70">
                  <span>{e.agent}</span>
                  <span>{relativeTime(e.receivedAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </Card>
  )
}

export function LiveContextPage() {
  const { entries, draft, submitted, isConnected } = useLiveContextWebSocket()

  // After a settings change persists, re-run retrieval for the most recent draft
  // so the preview re-tunes immediately without the user retyping.
  const handleSettingsSaved = () => {
    fetch(`${httpBase()}/api/live-context/rerun`, { method: 'POST' }).catch(() => {
      /* fail-open: preview refreshes on next keystroke */
    })
  }

  const latest = entries[0] || null
  // "typing" = a live draft exists that differs from the last retrieved draft.
  // Compare against the entry's rawDraft (the original typed text), not query,
  // which the monitor enriches with pane context — otherwise the draft never
  // matches the retrieved entry and the UI stays stuck on "typing…".
  const lastRetrievedDraft = latest?.rawDraft || latest?.query
  const typing = !!draft && draft.query.length > 0 && draft.query !== lastRetrievedDraft
  const headingQuery = draft?.query || latest?.rawDraft || latest?.query || ''
  const headingContext = draft?.context || ''
  const headingAgent = draft?.agent || latest?.agent || ''
  const headingProject = draft?.project || latest?.project || null
  const displayedEntry = typing ? null : latest

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Radio className="h-5 w-5 text-primary" /> Live Memory Context
          </h1>
          <p className="text-sm text-muted-foreground">
            Memory retrieved for the prompt you are typing in the CLI — before you press Enter.
          </p>
        </div>
        <Badge
          variant="outline"
          className={isConnected ? 'border-emerald-500 text-emerald-600' : 'border-muted text-muted-foreground'}
        >
          <span
            className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
              isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground'
            }`}
          />
          {isConnected ? 'Live' : 'Disconnected'}
        </Badge>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[260px_1fr]">
        {/* Submitted-query log */}
        <RecentQueries items={submitted} />

        {/* Heading (live typing) + memory columns for the live query */}
        <ScrollArea className="overflow-hidden">
          <div className="space-y-4 pr-2">
            <HeadingCard
              query={headingQuery}
              context={headingContext}
              agent={headingAgent}
              project={headingProject}
              isTyping={typing}
              latencyMs={latest?.meta?.latency_ms ?? null}
              resultsCount={latest?.meta?.results_count ?? null}
            />

            <RetrievalTuningPanel onSaved={handleSettingsSaved} />

            {latest?.error && !typing && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>Retrieval unavailable: {latest.error}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
              <MemoryColumns entry={displayedEntry} typing={typing} />
              <RankedResultsSidebar entry={displayedEntry} />
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export default LiveContextPage
