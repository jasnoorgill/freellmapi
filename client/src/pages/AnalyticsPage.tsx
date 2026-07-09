import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'

type TimeRange = '24h' | '7d' | '30d' | '90d'

// Response shapes mirror the JSON emitted by server/src/routes/analytics.ts.
// Latency percentiles and TTFT are null when the raw window is empty (pruned).
interface SummaryResponse {
  totalRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  requestTypeCounts: { chat: number; embedding: number }
  estimatedCostSavings: number
  pinnedRequests: number
  pinHonoredRequests: number
  firstRequestAt: string | null
  lifetimeTotalRequests: number
}

interface ByPlatformRow {
  platform: string
  requests: number
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  errorCount: number
  avgTokensPerSecond: number | null
  totalInputTokens: number
  totalOutputTokens: number
}

interface TimelineBucket {
  timestamp: string
  requests: number
  successCount: number
  failureCount: number
  inputTokens: number
  outputTokens: number
}

interface ByModelRow {
  platform: string
  modelId: string
  displayName: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
  pinnedRequests: number
  estimatedCost: number
}

interface ByKeyRow {
  keyId: number
  label: string | null
  platform: string | null
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

interface ErrorDistribution {
  byCategory: Array<{ category: string; count: number }>
  byPlatform: Array<{ platform: string; count: number }>
  detailed: Array<{ platform: string; model_id: string; error_category: string; count: number }>
}

interface RecentErrorRow {
  id: number
  platform: string
  modelId: string
  error: string
  latencyMs: number
  createdAt: string
}

interface RecentCallRow {
  id: number
  platform: string
  modelId: string
  requestedModel: string | null
  requestType: string
  status: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  error: string | null
  clientIp: string | null
  clientUserAgent: string | null
  createdAt: string
}

interface RecentCallsResponse {
  total: number
  rows: RecentCallRow[]
}

// First product token of the UA ("python-requests/2.32.3", "curl/8.6.0", …)
// is enough to tell callers apart in a narrow cell; full string on hover.
function shortUserAgent(ua: string | null): string {
  if (!ua) return '—'
  const first = ua.split(' ')[0]
  return first.length > 32 ? first.slice(0, 32) + '…' : first
}

const TIME_RANGES: readonly TimeRange[] = ['24h', '7d', '30d', '90d']
const STORAGE_KEY = 'freellmapi.analytics.range'
const DEFAULT_RANGE: TimeRange = '7d'

// Read the previously-selected range from localStorage. Invalid or missing
// values fall back to the 7d default so a corrupted entry never bricks the
// page; SSR-safety follows the same try/catch shape as `lib/api.ts`.
function loadStoredRange(): TimeRange {
  if (typeof window === 'undefined') return DEFAULT_RANGE
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && (TIME_RANGES as readonly string[]).includes(stored)) {
      return stored as TimeRange
    }
  } catch {
    /* localStorage unavailable (private mode, etc.) — use default */
  }
  return DEFAULT_RANGE
}

// Per-model table sort state. The `pinned` column is intentionally NOT
// sortable — it renders "—" for zero-pinned rows and the unsortable `0`/`>0`
// distinction would confuse the indicator. 3-state cycle per column:
// null → asc → desc → null. Switching to a new column resets to asc.
type SortColumn = 'model' | 'provider' | 'requests' | 'success' | 'latency' | 'inTokens' | 'outTokens' | 'saved'

const SORT_COLUMNS: readonly SortColumn[] = [
  'model', 'provider', 'requests', 'success', 'latency', 'inTokens', 'outTokens', 'saved',
]
const SORT_STORAGE_KEY = 'freellmapi.analytics.byModelSort'

function sortValue(row: any, col: SortColumn): number | string | null {
  switch (col) {
    case 'model': return row.displayName ?? null
    case 'provider': return row.platform ?? null
    case 'requests': return row.requests ?? null
    case 'success': return row.successRate ?? null
    case 'latency': return row.avgLatencyMs ?? null
    case 'inTokens': return row.totalInputTokens ?? null
    case 'outTokens': return row.totalOutputTokens ?? null
    case 'saved': return row.estimatedCost ?? null
  }
}

function compareRows(a: any, b: any, col: SortColumn): number {
  const av = sortValue(a, col)
  const bv = sortValue(b, col)
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  if (typeof av === 'number' && typeof bv === 'number') return av - bv
  return String(av).localeCompare(String(bv))
}

// Generic sort state for the recent-calls and usage-by-key tables on this
// page. The per-model table added sortable headers first in PR #490 with a
// non-generic shape; this generic helper lives next to it so the next table
// that wants sort can reuse `<SortableHeader<C>` and `compareBy<R, C>`
// without re-typing the comparator / storage boilerplate.
//
// 3-state cycle per column: null → asc → desc → null. Switching to a new
// column resets to asc.
type SortDirection = 'asc' | 'desc'
type SortState<C extends string> = { column: C; direction: SortDirection } | null

// Numeric/string accessor for a sortable column. Returns null for values
// the API didn't include so they sort to the bottom on asc and top on desc.
type SortValueFn<R, C extends string> = (row: R, col: C) => number | string | null

function compareBy<R, C extends string>(
  a: R, b: R, col: C, valueOf: SortValueFn<R, C>
): number {
  const av = valueOf(a, col)
  const bv = valueOf(b, col)
  // Nulls always last regardless of direction (Excel/Sheets convention).
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  if (typeof av === 'number' && typeof bv === 'number') return av - bv
  return String(av).localeCompare(String(bv))
}

function loadStoredSort<C extends string>(
  storageKey: string, validColumns: readonly C[]
): SortState<C> {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { column?: unknown; direction?: unknown }
    if (
      typeof parsed.column === 'string' &&
      (validColumns as readonly string[]).includes(parsed.column) &&
      (parsed.direction === 'asc' || parsed.direction === 'desc')
    ) {
      return { column: parsed.column as C, direction: parsed.direction }
    }
  } catch {
    /* corrupted JSON or storage unavailable — fall through to null */
  }
  return null
}

function persistSort<C extends string>(storageKey: string, sort: SortState<C>) {
  if (typeof window === 'undefined') return
  try {
    if (sort === null) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, JSON.stringify(sort))
  } catch {
    /* ignore — storage quota / private mode */
  }
}
function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// Generic sortable header cell. Renders the label + a state-aware
// indicator: unsorted → ChevronsUpDown (faded), asc → ArrowUp, desc →
// ArrowDown. Right-aligned columns flip the indicator order so it sits
// to the LEFT of the label, keeping the label closest to the data.
function SortableHeader<C extends string>({
  column,
  label,
  align,
  extraClass,
  sort,
  onClick,
}: {
  column: C
  label: string
  align: 'left' | 'right'
  extraClass?: string
  sort: SortState<C>
  onClick: (col: C) => void
}) {
  const active = sort?.column === column
  const direction = active ? sort.direction : null
  const indicator = direction === 'asc'
    ? <ArrowUp className="size-3 shrink-0" />
    : direction === 'desc'
    ? <ArrowDown className="size-3 shrink-0" />
    : <ChevronsUpDown className="size-3 shrink-0 opacity-40" />
  const alignClass = align === 'right' ? 'text-right' : ''
  const headClass = [alignClass, extraClass].filter(Boolean).join(' ')
  return (
    <TableHead className={headClass || undefined}>
      <button
        type="button"
        onClick={() => onClick(column)}
        aria-label={label}
        aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
        className={
          'inline-flex items-center gap-1 ' +
          (align === 'right' ? 'flex-row-reverse' : 'flex-row') +
          ' cursor-pointer select-none hover:text-foreground transition-colors ' +
          (active ? 'text-foreground' : 'text-muted-foreground')
        }
      >
        <span>{label}</span>
        {indicator}
      </button>
    </TableHead>
  )
}

function Stat({ label, value, hint, className }: { label: string; value: string | number; hint?: string; className?: string }) {
  const card = (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
  // Same portal tooltip as the routing strategy chips. Opens BELOW the card:
  // the stats row sits right under the sticky navbar.
  return hint ? <HoverTooltip text={hint} side="bottom" className="block">{card}</HoverTooltip> : card
}

// Persistence key for the analytics-page filter box. Same shape as the other
// freellmapi.* dashboard settings (#462). Sticky across reloads so a power user
// who's narrowed the view down to a single model doesn't have to retype every
// visit. Invalid / missing values fall back to empty string; SSR-safe.
const SEARCH_STORAGE_KEY = 'freellmapi.analytics.search'
function loadStoredSearch(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(SEARCH_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

// One filter matches if the query (trimmed, lower-cased) appears anywhere in the
// joined, lower-cased haystack. Empty query short-circuits to "match all" so
// the underlying array stays untouched. Case-insensitive substring (not fuzzy,
// not regex) — same shape FallbackPage uses (#343), so power users get one
// mental model across the dashboard.
type MatchesFn<T> = (row: T, q: string) => boolean
function makeMatches<T>(getHaystack: (row: T) => string): MatchesFn<T> {
  return (row, q) => {
    if (!q) return true
    return getHaystack(row).toLowerCase().includes(q)
  }
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'
const tooltipStyle = { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 } as const

// Two categorical series hues, validated against the app's actual chart
// surfaces (light card #ffffff, dark card #101010) with the dataviz palette
// checker. Slot A (blue) = the "average / input" series; slot B (aqua) = the
// "p95 / output" series. The app's own --chart-* tokens are all grayscale
// (zero chroma), which fails the CVD separation check for a two-series chart,
// so we take the nearest passing categorical hues and theme them here.
const seriesA = 'var(--series-a)'
const seriesB = 'var(--series-b)'
const chartVars = `
.analytics-viz { --series-a: #2a78d6; --series-b: #1baf7a; }
.dark .analytics-viz { --series-a: #3987e5; --series-b: #199e70; }
`


export default function AnalyticsPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<TimeRange>(loadStoredRange)
  // Capture "now" once at mount so the savings extrapolation below stays a pure
  // render (calling Date.now() during render is impure and non-deterministic).
  const [now] = useState(() => Date.now())
  // Page-wide filter. Filtered client-side over already-fetched rows so
  // keystrokes don't re-hit the API (the useQuery keys stay range-only).
  // Lazy init reads localStorage; persistence mirrors loadStoredRange in
  // shape. The query is trimmed + lowered once at the top of the filter
  // pipeline — passing it through unchanged means each `matches` impl stays
  // pure, but the trim+lower happens in every render where the user typed.
  // Cheap (8 memoized filters, total dataset < few hundred rows).
  const [search, setSearch] = useState<string>(loadStoredSearch)
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (search) window.localStorage.setItem(SEARCH_STORAGE_KEY, search)
      else window.localStorage.removeItem(SEARCH_STORAGE_KEY)
    } catch {
      /* ignore — storage quota / private mode */
    }
  }, [search])
  const trimmedQuery = search.trim().toLowerCase()

  // Remember the last-selected range across page reloads / new sessions so
  // the user lands back on the window they were inspecting. Same
  // localStorage shape as `theme` and `freellmapi.locale`.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, range)
    } catch {
      /* ignore — storage quota / private mode */
    }
  }, [range])

  // Per-model table sort. Cycle: null → asc → desc → null. Switching column
  // starts at asc on the new column. Persisted so the next visit lands on
  // the user's preferred sort.
  const [sort, setSort] = useState<SortState<SortColumn>>(() => loadStoredSort<SortColumn>(SORT_STORAGE_KEY, SORT_COLUMNS))
  useEffect(() => {
    persistSort(SORT_STORAGE_KEY, sort)
  }, [sort])

  const onHeaderClick = (col: SortColumn) => {
    setSort((current: SortState<SortColumn>) => {
      if (!current || current.column !== col) return { column: col, direction: 'asc' }
      if (current.direction === 'asc') return { column: col, direction: 'desc' }
      return null // third click on the same column → restore API order
    })
  }

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<ByPlatformRow[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<TimelineBucket[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<ByModelRow[]>(`/api/analytics/by-model?range=${range}`),
  })

  const { data: byKey = [] } = useQuery({
    queryKey: ['analytics', 'by-key', range],
    queryFn: () => apiFetch<ByKeyRow[]>(`/api/analytics/by-key?range=${range}`),
  })

  // Apply the user's sort to byModel. When sort is null we render the rows
  // in API-returned order; the API's natural ordering (requests DESC) is
  // the right default. The sort is stable within the comparator because we
  // fall back to insertion order for equal values (Array.prototype.sort is
  // stable in all modern engines).
  const sortedByModel = useMemo(() => {
    if (!sort) return byModel
    const copy = byModel.slice()
    copy.sort((a, b) => {
      const primary = compareRows(a, b, sort.column)
      return sort.direction === 'asc' ? primary : -primary
    })
    return copy
  }, [byModel, sort])

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<RecentErrorRow[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`),
  })

  const { data: recentCalls } = useQuery({
    queryKey: ['analytics', 'requests', range],
    queryFn: () => apiFetch<RecentCallsResponse>(`/api/analytics/requests?range=${range}&limit=100`),
  })

  // ----- Page-wide filter ----------------------------------------------------
  // One matches() builder per table, joined so the haystack is computed once
  // per row in the filter pass (instead of three times via three separate
  // predicates). For rows whose every field is a string primitive this is just
  // template-literal concatenation. The four tables each carry slightly
  // different searchable fields, so the haystack text is bespoke per row
  // type. Charts are deliberately NOT filtered — they aggregate over the
  // selected window and filtering them would misrepresent totals; the
  // summary stat cards and time-series charts already stay unfiltered.
  const matchesByModel = useMemo(
    () => makeMatches<ByModelRow>((r) => `${r.displayName} ${r.platform} ${r.modelId}`),
    []
  )
  const matchesByKey = useMemo(
    () => makeMatches<ByKeyRow>((r) => `${r.label ?? ''} ${r.platform ?? ''} #${r.keyId}`),
    []
  )
  const matchesRecentCall = useMemo(
    () => makeMatches<RecentCallRow>((r) =>
      `${r.clientIp ?? ''} ${r.clientUserAgent ?? ''} ${r.modelId} ${r.platform} ` +
      `${r.requestedModel ?? ''} ${r.status} ${r.error ?? ''} ${r.requestType}`
    ),
    []
  )
  const matchesRecentError = useMemo(
    () => makeMatches<RecentErrorRow>((r) => `${r.platform} ${r.modelId} ${r.error}`),
    []
  )
  // Filtered versions of every list-driven surface. Each uses .filter + the
  // `matches` helper so an empty query returns the array unmodified (no copy
  // when there is no filter — saves an allocation per render in the common
  // case). useMemo deps include trimmedQuery so a keystroke recomputes only
  // what's affected; the dependencies on the source arrays keep the filter
  // in sync with re-fetches when range changes.
  const visibleByModel = useMemo(
    () => trimmedQuery ? sortedByModel.filter((r) => matchesByModel(r, trimmedQuery)) : sortedByModel,
    [sortedByModel, matchesByModel, trimmedQuery]
  )
  const visibleErrors = useMemo(
    () => trimmedQuery ? errors.filter((r) => matchesRecentError(r, trimmedQuery)) : errors,
    [errors, matchesRecentError, trimmedQuery]
  )

  // Whether any filter is active at all. Renders the `noMatches` empty state
  // below instead of `noData` so the user understands "filter excluded
  // everything" vs "no traffic yet" — each panel checks `x.length === 0` plus
  // `trimmedQuery !== ''` to decide which message to show.

  // Savings card shows ONE stable monthly figure regardless of the selected
  // range: the last-30-days data projected to a full month from its actual
  // span (a young install with 2 days of data shows 15x its 2-day total).
  // Once 30 days of history exist the real total shows as-is. The hover
  // hint carries the selected period's actual amount and the projection
  // basis. Querying 30d separately is free: react-query shares the cache
  // with the 30d tab.
  const { data: summary30 } = useQuery({
    queryKey: ['analytics', 'summary', '30d'],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?range=30d`),
  })

  // Recent-calls table sort. Same 3-state cycle as the per-model table.
  // The `status` column is mapped to 0/1 so "error < success" sorts stably
  // regardless of how the upstream provider phrases failures.
  type RecentCallCol = 'time' | 'ip' | 'agent' | 'model' | 'provider' | 'status' | 'inTokens' | 'outTokens' | 'latency'
  const RECENT_CALL_COLS: readonly RecentCallCol[] = [
    'time', 'ip', 'agent', 'model', 'provider', 'status', 'inTokens', 'outTokens', 'latency',
  ]
  const RECENT_CALL_KEY = 'freellmapi.analytics.recentCallsSort'
  const [recentCallsSort, setRecentCallsSort] = useState<SortState<RecentCallCol>>(
    () => loadStoredSort<RecentCallCol>(RECENT_CALL_KEY, RECENT_CALL_COLS)
  )
  useEffect(() => persistSort(RECENT_CALL_KEY, recentCallsSort), [recentCallsSort])
  const recentCallsValueOf: SortValueFn<RecentCallRow, RecentCallCol> = (row, col) => {
    switch (col) {
      case 'time': return row.createdAt ?? null
      case 'ip': return row.clientIp ?? null
      case 'agent': return row.clientUserAgent ?? null
      case 'model': return row.modelId ?? null
      case 'provider': return row.platform ?? null
      // Map to 0/1 so ascending order is "errors first" no matter how
      // upstream phrases the failure ("error" vs "errors" vs "failed").
      case 'status': return row.status === 'success' ? 1 : 0
      case 'inTokens': return row.inputTokens ?? null
      case 'outTokens': return row.outputTokens ?? null
      case 'latency': return row.latencyMs ?? null
    }
  }
  const onRecentCallsHeaderClick = (col: RecentCallCol) => {
    setRecentCallsSort((current: SortState<RecentCallCol>) => {
      if (!current || current.column !== col) return { column: col, direction: 'asc' }
      if (current.direction === 'asc') return { column: col, direction: 'desc' }
      return null // third click → restore API-returned order
    })
  }

  // Usage-by-key table sort. Same shape. The `label` value-of falls back
  // to `#<id>` for untagged keys so they don't all bunch at the empty-
  // string tail under the comparator's nulls-always-last rule.
  type ByKeyCol = 'label' | 'provider' | 'requests' | 'success' | 'latency' | 'inTokens' | 'outTokens'
  const BY_KEY_COLS: readonly ByKeyCol[] = [
    'label', 'provider', 'requests', 'success', 'latency', 'inTokens', 'outTokens',
  ]
  const BY_KEY_KEY = 'freellmapi.analytics.byKeySort'
  const [byKeySort, setByKeySort] = useState<SortState<ByKeyCol>>(
    () => loadStoredSort<ByKeyCol>(BY_KEY_KEY, BY_KEY_COLS)
  )
  useEffect(() => persistSort(BY_KEY_KEY, byKeySort), [byKeySort])
  const byKeyValueOf: SortValueFn<ByKeyRow, ByKeyCol> = (row, col) => {
    switch (col) {
      case 'label': return row.label ?? (row.keyId != null ? `#${row.keyId}` : null)
      case 'provider': return row.platform ?? null
      case 'requests': return row.requests ?? null
      case 'success': return row.successRate ?? null
      case 'latency': return row.avgLatencyMs ?? null
      case 'inTokens': return row.totalInputTokens ?? null
      case 'outTokens': return row.totalOutputTokens ?? null
    }
  }
  const onByKeyHeaderClick = (col: ByKeyCol) => {
    setByKeySort((current: SortState<ByKeyCol>) => {
      if (!current || current.column !== col) return { column: col, direction: 'asc' }
      if (current.direction === 'asc') return { column: col, direction: 'desc' }
      return null
    })
  }

  // Apply the user's sort to recent-calls and usage-by-key. When sort is
  // null we render the rows in API-returned order; the API's natural
  // ordering (newest-first for recent-calls, requests DESC for by-key) is
  // the right default. The sort is stable within the comparator because
  // we fall back to insertion order for equal values (Array.prototype.sort
  // is stable in all modern engines).
  const sortedRecentCalls = useMemo(() => {
    const rows = recentCalls?.rows
    if (!rows) return rows
    if (!recentCallsSort) return rows
    const copy = rows.slice()
    const { column, direction } = recentCallsSort
    copy.sort((a, b) => {
      const primary = compareBy(a, b, column, recentCallsValueOf)
      return direction === 'asc' ? primary : -primary
    })
    return copy
  }, [recentCalls?.rows, recentCallsSort])

  const sortedByKey = useMemo(() => {
    if (!byKeySort) return byKey
    const copy = byKey.slice()
    const { column, direction } = byKeySort
    copy.sort((a, b) => {
      const primary = compareBy(a, b, column, byKeyValueOf)
      return direction === 'asc' ? primary : -primary
    })
    return copy
  }, [byKey, byKeySort])

  // Filtered versions of byKey and recentCalls. Sorted first, then search-
  // filtered, so the search box preserves the user's sort column.
  const visibleByKey = useMemo(
    () => trimmedQuery ? sortedByKey.filter((r) => matchesByKey(r, trimmedQuery)) : sortedByKey,
    [sortedByKey, matchesByKey, trimmedQuery]
  )
  const visibleRecentCalls = useMemo(() => {
    const rows = sortedRecentCalls
    if (!rows) return rows
    return trimmedQuery ? rows.filter((r) => matchesRecentCall(r, trimmedQuery)) : rows
  }, [sortedRecentCalls, matchesRecentCall, trimmedQuery])

  const actualSavings = summary?.estimatedCostSavings ?? 0
  const baseSavings = summary30?.estimatedCostSavings ?? 0
  const spanDays = (() => {
    if (!summary30?.firstRequestAt) return 30
    // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
    const first = new Date(summary30.firstRequestAt.replace(' ', 'T') + 'Z').getTime()
    const days = (now - first) / 86_400_000
    if (!Number.isFinite(days)) return 30
    return Math.min(Math.max(days, 1 / 24), 30)
  })()
  const extrapolated = spanDays < 29.5
  const savings30d = extrapolated ? baseSavings * (30 / spanDays) : baseSavings
  const rangeLabel = range === '24h' ? t('analytics.rangeLabel24h')
    : range === '7d' ? t('analytics.rangeLabel7d')
    : range === '30d' ? t('analytics.rangeLabel30d')
    : t('analytics.rangeLabel90d')
  const spanLabel = spanDays >= 2 ? t('analytics.spanDays', { count: Math.round(spanDays) }) : t('analytics.spanHours', { count: Math.max(1, Math.round(spanDays * 24)) })
  const savingsHint = extrapolated
    ? t('analytics.savingsHint', { actual: actualSavings.toFixed(2), range: rangeLabel, span: spanLabel })
    : t('analytics.savingsHintExact', { actual: actualSavings.toFixed(2), range: rangeLabel })

  // Pinned = the client named a specific model instead of auto-routing.
  // Honored = that model actually served it (the rest failed over).
  const pinned = summary?.pinnedRequests ?? 0
  const pinHonored = summary?.pinHonoredRequests ?? 0
  const chatCount = summary?.requestTypeCounts?.chat ?? 0
  const embeddingCount = summary?.requestTypeCounts?.embedding ?? 0
  const requestsHint = (pinned > 0
    ? t('analytics.requestsHintPinned', { pinned, honored: pinHonored, failed: pinned - pinHonored })
    : t('analytics.requestsHintAuto'))
    + ' ' + t('analytics.requestsHintTypes', { chat: chatCount, embedding: embeddingCount })

  // Avg time-to-first-token is null when nothing streamed (or the raw window
  // was pruned); show a placeholder glyph rather than a misleading "0 ms".
  const avgTtfb = summary?.avgTtfbMs
  const ttftValue = avgTtfb != null ? `${avgTtfb} ms` : '—'

  // p95 latency is likewise null when the raw window was pruned; the server
  // does NOT coerce it (unlike avg latency), so a null must render the same
  // placeholder glyph instead of a misleading "0 ms".
  const p95Latency = summary?.p95LatencyMs
  const p95Value = p95Latency != null ? `${p95Latency} ms` : '—'

  // TTFT-by-provider is empty when no provider recorded a streaming first
  // token; render a muted line instead of an axis-only empty chart.
  const ttftHasData = byPlatform.some((p) => (p.avgTtfbMs ?? 0) > 0)

  return (
    <div className="analytics-viz">
      <style>{chartVars}</style>
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Search box mirrors the FallbackPage toolbar (#343): Search icon
                on the left, X clear on the right, same rounded-xl border. Sized
                so the box doesn't dominate the page header — `w-56` is enough
                for ~25 chars of model/IP query, which covers every realistic
                filter. The Segment sits to the right on lg+ screens. */}
            <div className="relative w-full sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('models.searchPlaceholder')}
                aria-label={t('analytics.searchAriaLabel')}
                className="w-full rounded-xl border bg-card py-1.5 pl-8 pr-7 text-sm outline-none transition-colors focus:border-foreground/30"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label={t('models.clearSearch')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
            <SegmentedControl
              value={range}
              onValueChange={setRange}
              options={(['24h', '7d', '30d', '90d'] as TimeRange[]).map(r => ({
                value: r,
                label: t(r === '24h' ? 'analytics.range24h' : r === '7d' ? 'analytics.range7d' : r === '30d' ? 'analytics.range30d' : 'analytics.range90d'),
              }))}
              ariaLabel={t('analytics.title')}
            />
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-3">
          {summaryLoading ? (
            Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-3xl" />)
          ) : (
            <>
              <Stat label={t('analytics.requests')} value={summary?.totalRequests ?? 0} hint={requestsHint} />
              <Stat label={t('analytics.successRate')} value={`${summary?.successRate ?? 0}%`} />
              <Stat label={t('analytics.inputTokens')} value={formatTokens(summary?.totalInputTokens)} />
              <Stat label={t('analytics.outputTokens')} value={formatTokens(summary?.totalOutputTokens)} />
              <Stat label={t('analytics.avgLatency')} value={`${summary?.avgLatencyMs ?? 0} ms`} />
              <Stat label={t('analytics.p95Latency')} value={p95Value} />
              <Stat label={t('analytics.avgTtft')} value={ttftValue} />
              {/* Priced per request at the served model's paid-API equivalent
                  rate (not a flat frontier-model rate) — see db/model-pricing.ts.
                  The value is a 30-day projection; the hover hint tells the whole
                  story (actual period amount + whether it was extrapolated). */}
              <Stat label={t('analytics.estSavings')} value={`$${savings30d.toFixed(2)}`} hint={savingsHint} />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="lg:col-span-2">
            <Panel title={t('analytics.requestsOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name={t('common.success')} stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name={t('common.failures')} stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          {/* Tokens over time: input vs output, one axis, two-series legend. */}
          <div className="lg:col-span-2">
            <Panel title={t('analytics.tokensOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatTokens(v)} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatTokens(Number(value))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="inputTokens" name={t('analytics.inputTokens')} stroke={seriesA} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="outputTokens" name={t('analytics.outputTokens')} stroke={seriesB} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <Panel title={t('analytics.requestsByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="requests" name={t('analytics.requests')} fill={primaryFill} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Latency by provider: grouped avg + p95, same unit (ms), one axis. */}
          <Panel title={t('analytics.avgLatencyByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
                  <Bar dataKey="avgLatencyMs" name={t('analytics.avgLatency')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} />
                  <Bar dataKey="p95LatencyMs" name={t('analytics.p95Latency')} fill={seriesB} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Time to first token by provider (single series → no legend). */}
          <Panel title={t('analytics.ttftByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : !ttftHasData ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.ttftEmpty')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="avgTtfbMs" name={t('analytics.avgTtft')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Errors by category: horizontal bars, destructive hue, no legend. */}
          <Panel title={t('analytics.errorDistribution')}>
            {!errorDist?.byCategory?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byCategory} layout="vertical" margin={{ top: 6, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} allowDecimals={false} />
                  <YAxis type="category" dataKey="category" tick={axisStyle} tickLine={false} axisLine={false} width={128} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name={t('analytics.errors')} fill="var(--destructive)" radius={[0, 3, 3, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title={t('analytics.errorsByProvider')}>
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name={t('analytics.errors')} fill="var(--destructive)" radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title={t('analytics.recentErrors')}>
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : visibleErrors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{t('common.provider')}</TableHead>
                      <TableHead>{t('analytics.message')}</TableHead>
                      <TableHead className="text-right pr-4">{t('analytics.time')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleErrors.slice(0, 20).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">
                          <HoverTooltip text={e.error ?? ''} side="top">{e.error}</HoverTooltip>
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {formatSqliteUtcToLocalTime(e.createdAt, { hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          {/* Recent calls: one line per proxied request with the caller's IP +
              user agent. All local clients share the unified key, so this is
              the only view that answers "who is hitting the router". */}
          <div className="lg:col-span-2">
            <Panel title={t('analytics.recentCalls')}>
              {!recentCalls?.rows?.length ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : !visibleRecentCalls?.length ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
              ) : (
                <div className="max-h-[420px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHeader<RecentCallCol> column="time" label={t('analytics.time')} align="left" extraClass="pl-4" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="ip" label={t('analytics.clientIp')} align="left" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="agent" label={t('analytics.clientAgent')} align="left" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="model" label={t('common.model')} align="left" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="provider" label={t('common.provider')} align="left" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="status" label={t('common.status')} align="left" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="inTokens" label={t('analytics.inTokens')} align="right" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="outTokens" label={t('analytics.outTokens')} align="right" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                        <SortableHeader<RecentCallCol> column="latency" label={t('analytics.latency')} align="right" extraClass="pr-4" sort={recentCallsSort} onClick={onRecentCallsHeaderClick} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleRecentCalls.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatSqliteUtcToLocalTime(r.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </TableCell>
                          <TableCell className="text-xs font-medium tabular-nums">{r.clientIp ?? '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground" title={r.clientUserAgent ?? undefined}>
                            {shortUserAgent(r.clientUserAgent)}
                          </TableCell>
                          <TableCell className="text-xs max-w-[220px] truncate" title={r.requestedModel && r.requestedModel !== r.modelId ? t('analytics.requestedModelHint', { model: r.requestedModel }) : undefined}>
                            {r.modelId}
                            {r.requestedModel && r.requestedModel !== r.modelId ? ' *' : ''}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.platform}</TableCell>
                          <TableCell className={`text-xs ${r.status === 'success' ? 'text-muted-foreground' : 'text-destructive'}`} title={r.error ?? undefined}>
                            {r.status}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.inputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.outputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums pr-4">{r.latencyMs} ms</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title={t('analytics.perModelBreakdown')}>
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : visibleByModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHeader<SortColumn> column="model" label={t('common.model')} align="left" extraClass="pl-4" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader<SortColumn> column="provider" label={t('common.provider')} align="left" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader<SortColumn> column="requests" label={t('analytics.requests')} align="right" sort={sort} onClick={onHeaderClick} />
                        <TableHead className="text-right">{t('analytics.pinned')}</TableHead>
                        <SortableHeader<SortColumn> column="success" label={t('common.success')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader<SortColumn> column="latency" label={t('analytics.latency')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader<SortColumn> column="inTokens" label={t('analytics.inTokens')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader<SortColumn> column="outTokens" label={t('analytics.outTokens')} align="right" sort={sort} onClick={onHeaderClick} />
                        <SortableHeader<SortColumn> column="saved" label={t('analytics.saved')} align="right" extraClass="pr-4" sort={sort} onClick={onHeaderClick} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleByModel.map((m, i) => (
                        <TableRow key={i}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.pinnedRequests > 0 ? m.pinnedRequests : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">${(m.estimatedCost ?? 0).toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          {/* Usage by key: only rendered when the endpoint returns rows. */}
          {byKey.length > 0 && (
            <div className="lg:col-span-2">
              <Panel title={t('analytics.usageByKey')}>
                {visibleByKey.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noMatches')}</p>
                ) : (
                  <div className="max-h-[360px] overflow-y-auto -mx-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <SortableHeader<ByKeyCol> column="label" label={t('analytics.keyColumn')} align="left" extraClass="pl-4" sort={byKeySort} onClick={onByKeyHeaderClick} />
                          <SortableHeader<ByKeyCol> column="provider" label={t('common.provider')} align="left" sort={byKeySort} onClick={onByKeyHeaderClick} />
                          <SortableHeader<ByKeyCol> column="requests" label={t('analytics.requests')} align="right" sort={byKeySort} onClick={onByKeyHeaderClick} />
                          <SortableHeader<ByKeyCol> column="success" label={t('common.success')} align="right" sort={byKeySort} onClick={onByKeyHeaderClick} />
                          <SortableHeader<ByKeyCol> column="latency" label={t('analytics.latency')} align="right" sort={byKeySort} onClick={onByKeyHeaderClick} />
                          <SortableHeader<ByKeyCol> column="inTokens" label={t('analytics.inTokens')} align="right" sort={byKeySort} onClick={onByKeyHeaderClick} />
                          <SortableHeader<ByKeyCol> column="outTokens" label={t('analytics.outTokens')} align="right" extraClass="pr-4" sort={byKeySort} onClick={onByKeyHeaderClick} />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleByKey.map((k) => (
                          <TableRow key={k.keyId}>
                            <TableCell className="pl-4 text-sm font-medium">
                              {k.label || t('analytics.keyLabelFallback', { id: k.keyId })}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{k.platform ?? '—'}</TableCell>
                            <TableCell className="text-right tabular-nums">{k.requests}</TableCell>
                            <TableCell className="text-right tabular-nums">{k.successRate}%</TableCell>
                            <TableCell className="text-right tabular-nums">{k.avgLatencyMs} ms</TableCell>
                            <TableCell className="text-right tabular-nums">{formatTokens(k.totalInputTokens)}</TableCell>
                            <TableCell className="text-right tabular-nums pr-4">{formatTokens(k.totalOutputTokens)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </Panel>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
