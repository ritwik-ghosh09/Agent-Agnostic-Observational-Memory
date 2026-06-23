import { Fragment } from 'react'
import { useLiveContextWebSocket } from '@/hooks/useLiveContextWebSocket'
import type { LiveContextEntry, LiveSubmitted } from '@/hooks/useLiveContextWebSocket'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Brain, Database, Radio, Terminal, AlertTriangle, Send, Loader2 } from 'lucide-react'

const WORKING_HEADERS = ['Working Memory', 'Previous Session']
const OBSERVATIONAL_HEADERS = ['Insights', 'Digests', 'Entities', 'Observations']

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
                <div className="mb-1 text-sm font-semibold">{s.title}</div>
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

/** Main heading bar — streams the prompt the user is typing in the CLI. */
function HeadingCard({
  query,
  agent,
  project,
  isTyping,
  latencyMs,
  resultsCount,
}: {
  query: string
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

  const latest = entries[0] || null
  // "typing" = a live draft exists that differs from the last retrieved query.
  const typing = !!draft && draft.query.length > 0 && draft.query !== latest?.query
  const headingQuery = draft?.query || latest?.query || ''
  const headingAgent = draft?.agent || latest?.agent || ''
  const headingProject = draft?.project || latest?.project || null

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
              agent={headingAgent}
              project={headingProject}
              isTyping={typing}
              latencyMs={latest?.meta?.latency_ms ?? null}
              resultsCount={latest?.meta?.results_count ?? null}
            />

            {latest?.error && !typing && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>Retrieval unavailable: {latest.error}</AlertDescription>
              </Alert>
            )}

            <MemoryColumns entry={typing ? null : latest} typing={typing} />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export default LiveContextPage
