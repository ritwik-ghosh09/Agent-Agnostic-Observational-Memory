import { type ReactNode } from 'react'
import { Info, SlidersHorizontal } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  EXPONENT_MAX,
  EXPONENT_MIN,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  useRetrievalSettings,
  type RetrievalSettings,
  type SimilaritySettings,
} from '@/hooks/useRetrievalSettings'

interface InfoTipProps {
  text: string
}

function InfoTip({ text }: InfoTipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More info"
          className="inline-flex text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  )
}

interface ControlRowProps {
  label: string
  info: string
  value: ReactNode
  children: ReactNode
}

function ControlRow({ label, info, value, children }: ControlRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground/90">{label}</span>
          <InfoTip text={info} />
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      {children}
    </div>
  )
}

interface SimilarityGroupProps {
  title: string
  titleInfo: string
  group: SimilaritySettings
  copy: {
    threshold: string
    exponential: string
    exponent: string
  }
  onThreshold: (v: number) => void
  onExponentialToggle: (v: boolean) => void
  onExponent: (v: number) => void
}

function SimilarityGroup({
  title,
  titleInfo,
  group,
  copy,
  onThreshold,
  onExponentialToggle,
  onExponent,
}: SimilarityGroupProps) {
  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-2.5">
      <div className="flex items-center gap-1.5">
        <h4 className="text-xs font-semibold">{title}</h4>
        <InfoTip text={titleInfo} />
      </div>

      <ControlRow label="Threshold" info={copy.threshold} value={group.threshold.toFixed(2)}>
        <Slider
          value={[group.threshold]}
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={0.01}
          onValueChange={([v]) => onThreshold(v)}
          aria-label={`${title} threshold`}
        />
      </ControlRow>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground/90">Exponential</span>
          <InfoTip text={copy.exponential} />
        </div>
        <Switch
          checked={group.exponentialEnabled}
          onCheckedChange={onExponentialToggle}
          aria-label={`${title} exponential weighting`}
        />
      </div>

      <ControlRow
        label="Exponent (k)"
        info={copy.exponent}
        value={group.exponentialEnabled ? group.exponent.toFixed(1) : '—'}
      >
        <Slider
          value={[group.exponent]}
          min={EXPONENT_MIN}
          max={EXPONENT_MAX}
          step={0.5}
          disabled={!group.exponentialEnabled}
          onValueChange={([v]) => onExponent(v)}
          aria-label={`${title} exponent`}
          className={group.exponentialEnabled ? '' : 'opacity-50'}
        />
      </ControlRow>
    </div>
  )
}

const COPY = {
  queryQuery: {
    title:
      'Controls how past human-ranked queries influence the current ranking (learned re-ranking feedback).',
    threshold:
      'Minimum cosine similarity between your current query and a past human-ranked query for that feedback to influence ranking. Higher = stricter.',
    exponential:
      'When on, closer past queries count much more than loosely-similar ones (weight = similarity^k). Off = linear (raw cosine).',
    exponent:
      'Sharpness of the query-similarity falloff. Higher k = only near-duplicate queries matter.',
  },
  queryItem: {
    title: 'Controls how strongly raw item similarity shapes which memories are retrieved.',
    threshold: 'Minimum cosine similarity for a memory item to be retrieved for your query.',
    exponential:
      'When on, items very similar to your query are emphasized over loosely-similar ones (score ×= similarity^k). Off = rank-based only.',
    exponent:
      'Sharpness of the item-similarity emphasis. Higher k = only near-duplicate items keep their score.',
  },
} as const

interface RetrievalTuningPanelProps {
  /** Called after settings persist so the caller can re-run the live preview. */
  onSaved?: () => void
}

/**
 * Global retrieval scoring controls. Two similarity groups (Query↔Query and
 * Query↔Item), each with a cosine threshold slider, an exponential on/off switch,
 * and an exponent slider (disabled when the switch is off). Every control has an
 * info icon with a hover tooltip. Changes persist server-side (debounced) and
 * apply to both the KnowledgeInjectionHook and this live preview.
 */
export function RetrievalTuningPanel({ onSaved }: RetrievalTuningPanelProps) {
  const { settings, loading, saving, error, setField } = useRetrievalSettings({ onSaved })

  const mk = (group: keyof RetrievalSettings) => ({
    onThreshold: (v: number) => setField(group, 'threshold', v),
    onExponentialToggle: (v: boolean) => setField(group, 'exponentialEnabled', v),
    onExponent: (v: number) => setField(group, 'exponent', v),
  })

  return (
    <TooltipProvider delayDuration={150}>
      <Card>
        <CardHeader className="px-4 py-2.5">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SlidersHorizontal className="size-4 text-primary" />
            Retrieval Tuning
            {saving && <span className="text-xs font-normal text-muted-foreground">saving…</span>}
            {error && <span className="text-xs font-normal text-destructive">{error}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 pt-0">
          <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            <SimilarityGroup
              title="Query ↔ Query"
              titleInfo={COPY.queryQuery.title}
              group={settings.queryQuery}
              copy={COPY.queryQuery}
              {...mk('queryQuery')}
            />
            <SimilarityGroup
              title="Query ↔ Item"
              titleInfo={COPY.queryItem.title}
              group={settings.queryItem}
              copy={COPY.queryItem}
              {...mk('queryItem')}
            />
          </div>
          {loading && (
            <p className="mt-2 text-xs text-muted-foreground">Loading current settings…</p>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  )
}

export default RetrievalTuningPanel
