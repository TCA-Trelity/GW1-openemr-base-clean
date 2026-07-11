// "Ask the record" (S2.3, R5 native citations, M6 promotion): the co-pilot's primary
// conversational surface — a persistent pane beside the tabs at desktop widths (App opens
// it with the patient and shifts content aside), a slide-over drawer on narrow screens.
// Ask-about-this affordances across Overview, Imaging, and AI Insights seed the input via
// the `seed` prop; the physician sends (one keystroke), so every seeded ask continues the
// same persisted conversation. Replies stream over POST /api/chat SSE as clean prose — no
// inline tokens. Provenance rides the stream's citation events (already server-verified
// verbatim against the stored documents): verified citations render as source-labelled
// chips appended to the bubble, deep-linking into the source viewer at the cited character
// range; unverified ones are never rendered as chips, only counted in the amber footer.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
    AlertTriangle,
    Check,
    Eye,
    FileText,
    GitCompare,
    HelpCircle,
    Loader2,
    MessageCircle,
    RefreshCw,
    ScanEye,
    Search,
    Send,
    ShieldAlert,
    TrendingUp,
    Wrench,
    X,
    type LucideIcon,
} from 'lucide-react';
import { fetchChatHistory, sendChatMessage } from './api';
import type { ChatCompareSummary, ChatToolSummary, ChatTrendSummary } from './api';
import type { ChatCitation, CitationRef, ImageRecord } from './types';
import { CitationChips } from './CitationChip';
import ScanImage from './imaging/ScanImage';
import { asSourceType, formatDate, titleCase } from './ui';

const MAX_MESSAGE_CHARS = 2000; // mirrors routes/chat.ts MAX_MESSAGE_CHARS

// The first asks a grader sees — they model the sanctioned thought-partner shapes
// (docs/prompt-guide.md): what-changed, risk surfacing, open questions. None requests
// a treatment decision.
const QUICK_PROMPTS = [
    'What brings her in today?',
    'Any medication risks?',
    'What changed since the last visit?',
    'What questions are worth asking today?',
];

// ---- Per-patient conversation persistence (sessionStorage keyed by patient id) ----

const storageKey = (patientId: string): string => `copilot.chat.${patientId}`;

function readStoredConversationId(patientId: string): string | null {
    try {
        return window.sessionStorage.getItem(storageKey(patientId));
    } catch {
        return null;
    }
}

function storeConversationId(patientId: string, conversationId: string): void {
    try {
        window.sessionStorage.setItem(storageKey(patientId), conversationId);
    } catch {
        // Persistence is best-effort; the in-memory conversation still works.
    }
}

// ---- Message model ----

interface ChatBubble {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    /** M9: the agent's opening move — rendered with its prepared-during-check-in label. */
    opening?: boolean;
    status: 'complete' | 'streaming' | 'error';
    /** Streamed citations in arrival order, deduped — replayed history carries none. */
    citations: ChatCitation[];
    /** From the done event; unverifiable spans are surfaced here, never as chips. */
    unverifiedCount: number;
    /** Tools the model invoked this turn, in call order (TC3) — [] when it answered from the bundle. */
    toolActivity: ToolActivity[];
    /** The user message that produced this assistant bubble — what Retry resends. */
    requestText: string;
    errorText: string | null;
}

let nextBubbleSeq = 0;
function bubbleId(prefix: string): string {
    nextBubbleSeq += 1;
    return `${prefix}-${nextBubbleSeq}`;
}

// ---- Citation handling ----

const citationKey = (citation: ChatCitation): string => `${citation.document_id}:${citation.start_char}`;

function appendCitation(citations: ChatCitation[], citation: ChatCitation): ChatCitation[] {
    return citations.some((existing) => citationKey(existing) === citationKey(citation))
        ? citations
        : [...citations, citation];
}

function dedupeCitations(citations: ChatCitation[]): ChatCitation[] {
    const seen = new Set<string>();
    const out: ChatCitation[] = [];
    for (const citation of citations) {
        const key = citationKey(citation);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(citation);
        }
    }
    return out;
}

/**
 * Project a ChatCitation into the shared CitationRef so the chip deep-links into the
 * existing source viewer with the cited character range highlighted. The backend titles
 * documents `${document_type} (${document_date})` — split that back apart for the card.
 */
export function chatCitationRef(citation: ChatCitation): CitationRef {
    const titleMatch = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(citation.document_title);
    const typePart = titleMatch?.[1] ?? citation.document_title;
    const datePart = titleMatch?.[2];
    return {
        id: `chat-${citationKey(citation)}`,
        source_label: titleCase(typePart),
        source_type: asSourceType(typePart),
        excerpt_text: citation.cited_text,
        excerpt_location:
            citation.start_char >= 0 && citation.end_char > citation.start_char
                ? {
                      type: 'character_range',
                      start_char: citation.start_char,
                      end_char: citation.end_char,
                      context_before: null,
                      context_after: null,
                  }
                : null,
        attribution: null,
        source_document_id: citation.document_id,
        document_date: datePart !== undefined && datePart !== '' && datePart !== 'null' ? datePart : null,
    };
}

// ---- Tool activity (TC3) ----

/** One tool invocation shown in the assistant bubble: which tool, a short input hint, its state. */
interface ToolActivity {
    id: string;
    /** Raw tool name from the stream (e.g. 'search_record'). */
    name: string;
    /** A short human hint pulled from the tool input (query/metric/document), else null. */
    descriptor: string | null;
    status: 'running' | 'ok' | 'error';
    /** IC2: render-ready projection of an imaging result (sparkline / compare pair), else null. */
    summary: ChatToolSummary | null;
}

let nextToolSeq = 0;
function toolActivityId(): string {
    nextToolSeq += 1;
    return `tool-${nextToolSeq}`;
}

// Friendly labels + icons for the eight read-only tools; unknown names humanize gracefully.
const TOOL_LABELS: Record<string, string> = {
    get_full_document: 'Read full document',
    get_measurement_trend: 'Traced measurement trend',
    compare_scans: 'Compared scans',
    get_imaging_overview: 'Summarized imaging history',
    describe_scan: 'Looked at the scan',
    check_med_risk: 'Checked medication risk',
    search_record: 'Searched the record',
    get_open_questions: 'Reviewed open questions',
};

const TOOL_ICONS: Record<string, LucideIcon> = {
    get_full_document: FileText,
    get_measurement_trend: TrendingUp,
    compare_scans: GitCompare,
    get_imaging_overview: ScanEye,
    describe_scan: Eye,
    check_med_risk: ShieldAlert,
    search_record: Search,
    get_open_questions: HelpCircle,
};

function toolLabel(name: string): string {
    return TOOL_LABELS[name] ?? name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// The most demo-legible field from a tool's input, truncated — never a whole object dump.
function toolDescriptor(input: Record<string, unknown>): string | null {
    for (const key of ['query', 'metric', 'medication', 'document_id', 'image_id', 'scan_id']) {
        const value = input[key];
        if (typeof value === 'string' && value.trim() !== '') {
            return value.length > 40 ? `${value.slice(0, 39)}…` : value;
        }
    }
    return null;
}

/** Mark the first still-running activity with this tool name as ok/error (tools can repeat). */
function resolveFirstRunning(
    activity: ToolActivity[],
    name: string,
    status: 'ok' | 'error',
    summary: ChatToolSummary | null = null,
): ToolActivity[] {
    let resolved = false;
    return activity.map((item) => {
        if (!resolved && item.name === name && item.status === 'running') {
            resolved = true;
            return { ...item, status, summary };
        }
        return item;
    });
}

/** When a turn settles, no activity should still show as running. */
function finalizeRunning(activity: ToolActivity[], status: 'ok' | 'error'): ToolActivity[] {
    return activity.map((item) => (item.status === 'running' ? { ...item, status } : item));
}

function ToolActivityStrip({ activity }: { activity: ToolActivity[] }) {
    if (activity.length === 0) {
        return null;
    }
    return (
        <div data-testid="tool-activity" className="mb-1.5 flex flex-wrap gap-1.5" aria-label="Tools consulted">
            {activity.map((item) => {
                const Icon = TOOL_ICONS[item.name] ?? Wrench;
                const running = item.status === 'running';
                const failed = item.status === 'error';
                return (
                    <span
                        key={item.id}
                        data-testid="tool-chip"
                        data-status={item.status}
                        title={running ? 'Running…' : failed ? 'Tool returned no result' : 'Done'}
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] leading-none ${
                            failed
                                ? 'border-amber-200 bg-amber-50 text-amber-700'
                                : 'border-slate-200 bg-slate-50 text-slate-600'
                        }`}
                    >
                        <Icon className="w-3 h-3 flex-shrink-0" />
                        <span className="font-medium">{toolLabel(item.name)}</span>
                        {item.descriptor !== null && <span className="text-slate-400">{item.descriptor}</span>}
                        {running ? (
                            <Loader2 className="w-3 h-3 flex-shrink-0 animate-spin text-slate-400" />
                        ) : failed ? (
                            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                        ) : (
                            <Check className="w-3 h-3 flex-shrink-0 text-emerald-500" />
                        )}
                    </span>
                );
            })}
        </div>
    );
}

// ---- Imaging result visuals (IC2): draw the data the model saw, linked to the viewer ----

const EYE_STROKES: Record<string, string> = { od: '#2563eb', os: '#7c3aed' };

/** Inline sparkline of a measurement trend; each point opens its scan in the workspace. */
function TrendSparkline({ summary, onOpenScan }: { summary: ChatTrendSummary; onOpenScan?: (id: string) => void }) {
    const WIDTH = 200;
    const HEIGHT = 44;
    const PAD = 6;
    const values = summary.series.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const y = (value: number) => HEIGHT - PAD - ((value - min) / span) * (HEIGHT - 2 * PAD);

    // One polyline per eye present (a mixed series is really two series).
    const eyes = [...new Set(summary.series.map((point) => point.laterality ?? ''))];
    const groups = eyes.map((eye) => {
        const points = summary.series.filter((point) => (point.laterality ?? '') === eye);
        const x = (index: number) =>
            points.length === 1 ? WIDTH / 2 : PAD + (index * (WIDTH - 2 * PAD)) / (points.length - 1);
        return { eye, points, x };
    });
    const unit = summary.series.length > 0 ? `${String(min)}–${String(max)}` : '';

    return (
        <div data-testid="chat-trend-sparkline" className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
            <p className="mb-1 text-[11px] leading-none text-slate-500">
                <span className="font-medium text-slate-600">{titleCase(summary.metric)}</span>
                {' · '}
                {summary.series.length} point{summary.series.length === 1 ? '' : 's'} · {unit}
                {eyes.filter((eye) => eye !== '').length > 1 && ' · OD blue / OS violet'}
            </p>
            <svg viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} className="block w-full" style={{ maxWidth: WIDTH }} role="img" aria-label={`${summary.metric} trend`}>
                {groups.map(({ eye, points, x }) => (
                    <g key={eye === '' ? 'unknown' : eye}>
                        {points.length > 1 && (
                            <polyline
                                fill="none"
                                stroke={EYE_STROKES[eye] ?? '#64748b'}
                                strokeWidth="1.5"
                                points={points.map((point, index) => `${String(x(index))},${String(y(point.value))}`).join(' ')}
                            />
                        )}
                        {points.map((point, index) => (
                            <circle
                                key={point.image_id + String(index)}
                                data-testid="chat-trend-point"
                                role="button"
                                aria-label={`Open scan — ${point.date === null ? point.image_id : formatDate(point.date)} (${String(point.value)})`}
                                cx={x(index)}
                                cy={y(point.value)}
                                r="3.5"
                                fill={EYE_STROKES[eye] ?? '#64748b'}
                                className={onOpenScan === undefined ? '' : 'cursor-pointer'}
                                onClick={() => onOpenScan?.(point.image_id)}
                            >
                                <title>{`${point.date ?? point.image_id}: ${String(point.value)}`}</title>
                            </circle>
                        ))}
                    </g>
                ))}
            </svg>
            {onOpenScan !== undefined && <p className="mt-0.5 text-[10px] leading-none text-slate-400">Click a point to open that scan</p>}
        </div>
    );
}

/** Prior/current thumbnails for a scan comparison; either opens its scan in the workspace. */
function ComparePair({
    summary,
    images,
    onOpenScan,
}: {
    summary: ChatCompareSummary;
    images: ImageRecord[];
    onOpenScan?: (id: string) => void;
}) {
    const sides: { label: string; id: string }[] = [
        { label: 'Prior', id: summary.prior_image_id },
        { label: 'Current', id: summary.current_image_id },
    ];
    return (
        <div data-testid="chat-compare-pair" className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
            <p className="mb-1.5 text-[11px] leading-none text-slate-500">
                <span className="font-medium text-slate-600">Scan comparison</span>
                {summary.overall_change !== undefined && ` · overall ${summary.overall_change.replace(/_/g, ' ')}`}
            </p>
            <div className="flex gap-2">
                {sides.map(({ label, id }) => {
                    const record = images.find((image) => image.id === id);
                    return (
                        <button
                            key={label}
                            type="button"
                            data-testid="chat-compare-thumb"
                            aria-label={`Open ${label.toLowerCase()} scan in the imaging workspace`}
                            onClick={() => onOpenScan?.(id)}
                            className="flex-1 rounded-lg border border-slate-200 p-1.5 text-left hover:border-blue-300 hover:shadow-sm transition-all"
                        >
                            {record !== undefined && <ScanImage image={record} className="w-full h-14 mb-1" />}
                            <span className="block text-[11px] font-medium leading-tight text-slate-600">{label}</span>
                            <span className="block text-[10px] leading-tight text-slate-400">
                                {record === undefined ? id : formatDate(record.image_metadata.capture_date)}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** All imaging visuals for a bubble, in tool order — rendered between the chips and the prose. */
function ToolResultVisuals({
    activity,
    images,
    onOpenScan,
}: {
    activity: ToolActivity[];
    images: ImageRecord[];
    onOpenScan?: (id: string) => void;
}) {
    const withSummaries = activity.filter((item) => item.summary !== null);
    if (withSummaries.length === 0) {
        return null;
    }
    return (
        <div className="mb-1.5 space-y-2">
            {withSummaries.map((item) =>
                item.summary!.kind === 'trend' ? (
                    <TrendSparkline key={item.id} summary={item.summary as ChatTrendSummary} {...(onOpenScan === undefined ? {} : { onOpenScan })} />
                ) : (
                    <ComparePair key={item.id} summary={item.summary as ChatCompareSummary} images={images} {...(onOpenScan === undefined ? {} : { onOpenScan })} />
                ),
            )}
        </div>
    );
}

// ---- Bubbles ----

function AssistantBubble({
    bubble,
    onRetry,
    images,
    onOpenScan,
}: {
    bubble: ChatBubble;
    onRetry: (bubble: ChatBubble) => void;
    images: ImageRecord[];
    onOpenScan?: (id: string) => void;
}) {
    // Chips: verified citations only, in arrival order — an unverifiable citation is never provenance.
    const chips = useMemo(
        () => bubble.citations.filter((citation) => citation.verified).map(chatCitationRef),
        [bubble.citations],
    );
    return (
        <div className="flex justify-start">
            <div className="max-w-[85%]">
                {bubble.opening === true && (
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Opening move — prepared during check-in
                    </p>
                )}
                <ToolActivityStrip activity={bubble.toolActivity} />
                <ToolResultVisuals activity={bubble.toolActivity} images={images} {...(onOpenScan === undefined ? {} : { onOpenScan })} />
                {/* IC4: the model looked at scan pixels — flag that part of this reply is an
                    AI visual observation, not sourced from (or citable to) the record. */}
                {bubble.toolActivity.some((item) => item.name === 'describe_scan') && (
                    <p
                        data-testid="visual-observation-banner"
                        className="mb-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-violet-200 bg-violet-50 text-[11px] leading-none text-violet-700"
                    >
                        <Eye className="w-3 h-3 flex-shrink-0" />
                        Includes AI visual observation — not from the record
                    </p>
                )}
                {(bubble.content !== '' || bubble.status === 'streaming' || chips.length > 0) && (
                    <div className="rounded-xl rounded-bl-sm bg-slate-100 px-3.5 py-2 text-[13px] text-slate-700 leading-snug whitespace-pre-wrap">
                        {bubble.content}
                        {bubble.status === 'streaming' && (
                            <span
                                data-testid="chat-streaming"
                                className="inline-block w-1.5 h-3.5 ml-0.5 align-middle rounded-sm bg-slate-400 animate-pulse"
                            />
                        )}
                        {chips.length > 0 && <CitationChips citations={chips} />}
                    </div>
                )}
                {bubble.status === 'complete' && bubble.unverifiedCount > 0 && (
                    <p className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-xs text-amber-700">
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                        {bubble.unverifiedCount} citation{bubble.unverifiedCount === 1 ? '' : 's'} could not be verified
                    </p>
                )}
                {bubble.status === 'error' && (
                    <div className="mt-1.5 flex items-center gap-2">
                        <p className="text-xs text-red-600">{bubble.errorText ?? 'The reply failed.'}</p>
                        <button
                            type="button"
                            onClick={() => onRetry(bubble)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
                        >
                            <RefreshCw className="w-3 h-3" />
                            Retry
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

// ---- The drawer ----

export default function ChatDrawer({
    patientId,
    open,
    onToggle,
    seed = null,
    viewingImageId = null,
    images = [],
    onOpenScan,
}: {
    patientId: string;
    open: boolean;
    onToggle: (open: boolean) => void;
    /** Ask-about-this seeding (M6): prefills the input (never auto-sends) and focuses it. */
    seed?: { text: string; nonce: number } | null;
    /** IC3: the scan open in the imaging workspace — sent with each turn so "this scan" resolves. */
    viewingImageId?: string | null;
    /** IC2: the patient's image records, so compare summaries can render real thumbnails. */
    images?: ImageRecord[];
    /** IC2: opens a scan in the imaging workspace (clicked sparkline point / compare thumb). */
    onOpenScan?: (id: string) => void;
}) {
    const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const conversationIdRef = useRef<string | null>(readStoredConversationId(patientId));
    const sendingRef = useRef(false);
    const historyRequested = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // First open with a stored conversation id: replay its history via GET (text only —
    // replayed messages carry no citations).
    useEffect(() => {
        if (!open || historyRequested.current) {
            return;
        }
        historyRequested.current = true;
        const stored = conversationIdRef.current;
        if (stored === null) {
            return;
        }
        setHistoryLoading(true);
        void fetchChatHistory(patientId, stored).then((result) => {
            if (result.kind === 'ready') {
                setBubbles((prev) =>
                    prev.length > 0
                        ? prev
                        : result.messages.map(
                              (message): ChatBubble => ({
                                  id: bubbleId('history'),
                                  role: message.role,
                                  content: message.content,
                                  status: 'complete',
                                  citations: [],
                                  unverifiedCount: 0,
                                  toolActivity: [],
                                  requestText: '',
                                  errorText: null,
                              }),
                          ),
                );
            } else {
                setHistoryError(result.message);
            }
            setHistoryLoading(false);
        });
    }, [open, patientId]);

    // Keep the newest turn in view; focus the input whenever the drawer opens.
    useEffect(() => {
        if (open && scrollRef.current !== null) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [open, bubbles]);
    useEffect(() => {
        if (open) {
            inputRef.current?.focus();
        }
    }, [open]);

    // A seeded ask prefills the draft and focuses — the physician stays in control of the
    // send (thought-partner posture: no turn fires, and no tokens spend, without their key).
    useEffect(() => {
        if (seed !== null) {
            setDraft(seed.text);
            inputRef.current?.focus();
        }
    }, [seed]);

    const patch = useCallback((id: string, update: (bubble: ChatBubble) => ChatBubble) => {
        setBubbles((prev) => prev.map((bubble) => (bubble.id === id ? update(bubble) : bubble)));
    }, []);

    /** One streamed turn against an already-appended assistant placeholder bubble. */
    const run = useCallback(
        async (text: string, assistantId: string) => {
            sendingRef.current = true;
            setSending(true);
            const result = await sendChatMessage(
                patientId,
                text,
                conversationIdRef.current,
                (delta) => {
                    patch(assistantId, (bubble) => ({ ...bubble, content: bubble.content + delta }));
                },
                (citation) => {
                    // Verified chips render live as they stream; dedupe by document+start.
                    patch(assistantId, (bubble) => ({ ...bubble, citations: appendCitation(bubble.citations, citation) }));
                },
                (tool) => {
                    // A tool started — show it running immediately (tools run before the text).
                    patch(assistantId, (bubble) => ({
                        ...bubble,
                        toolActivity: [
                            ...bubble.toolActivity,
                            { id: toolActivityId(), name: tool.name, descriptor: toolDescriptor(tool.input), status: 'running', summary: null },
                        ],
                    }));
                },
                (tool) => {
                    patch(assistantId, (bubble) => ({
                        ...bubble,
                        toolActivity: resolveFirstRunning(bubble.toolActivity, tool.name, tool.ok ? 'ok' : 'error', tool.summary ?? null),
                    }));
                },
                (seedContent) => {
                    // M9 opening move: fires only on the first turn of a fresh conversation,
                    // so prepending puts the agent's prepared digest at the top of the thread.
                    setBubbles((prev) => [
                        {
                            id: bubbleId('opening'),
                            role: 'assistant',
                            content: seedContent,
                            opening: true,
                            status: 'complete',
                            citations: [],
                            unverifiedCount: 0,
                            toolActivity: [],
                            requestText: '',
                            errorText: null,
                        },
                        ...prev,
                    ]);
                },
                { viewingImageId },
            );
            if (result.kind === 'done') {
                conversationIdRef.current = result.done.conversationId;
                storeConversationId(patientId, result.done.conversationId);
                patch(assistantId, (bubble) => ({
                    ...bubble,
                    status: 'complete',
                    citations: dedupeCitations(result.done.citations),
                    unverifiedCount: result.done.unverifiedCount,
                    // A settled turn never shows a spinner: any unmatched tool_result finalizes to ok.
                    toolActivity: finalizeRunning(bubble.toolActivity, 'ok'),
                }));
            } else if (result.kind === 'stream_error') {
                patch(assistantId, (bubble) => ({
                    ...bubble,
                    status: 'error',
                    errorText: 'The reply was interrupted.',
                    toolActivity: finalizeRunning(bubble.toolActivity, 'error'),
                }));
            } else {
                patch(assistantId, (bubble) => ({
                    ...bubble,
                    status: 'error',
                    errorText: result.message,
                    toolActivity: finalizeRunning(bubble.toolActivity, 'error'),
                }));
            }
            sendingRef.current = false;
            setSending(false);
        },
        [patientId, patch, viewingImageId],
    );

    const send = useCallback(
        (raw: string) => {
            const text = raw.trim();
            if (text === '' || text.length > MAX_MESSAGE_CHARS || sendingRef.current) {
                return;
            }
            const assistantId = bubbleId('assistant');
            setBubbles((prev) => [
                ...prev,
                {
                    id: bubbleId('user'),
                    role: 'user',
                    content: text,
                    status: 'complete',
                    citations: [],
                    unverifiedCount: 0,
                    toolActivity: [],
                    requestText: '',
                    errorText: null,
                },
                {
                    id: assistantId,
                    role: 'assistant',
                    content: '',
                    status: 'streaming',
                    citations: [],
                    unverifiedCount: 0,
                    toolActivity: [],
                    requestText: text,
                    errorText: null,
                },
            ]);
            setDraft('');
            void run(text, assistantId);
        },
        [run],
    );

    const retry = useCallback(
        (bubble: ChatBubble) => {
            if (sendingRef.current || bubble.requestText === '') {
                return;
            }
            patch(bubble.id, (prev) => ({
                ...prev,
                content: '',
                status: 'streaming',
                citations: [],
                unverifiedCount: 0,
                toolActivity: [],
                errorText: null,
            }));
            void run(bubble.requestText, bubble.id);
        },
        [patch, run],
    );

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send(draft);
        }
    };

    return (
        <>
            {!open && (
                <button
                    type="button"
                    onClick={() => onToggle(true)}
                    className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 px-4 py-3 rounded-full bg-slate-800 text-white text-sm font-medium shadow-lg hover:bg-slate-700 transition-colors"
                >
                    <MessageCircle className="w-4 h-4" />
                    Ask the record
                </button>
            )}
            <aside
                aria-label="Ask the record"
                aria-hidden={!open}
                className={`fixed inset-y-0 right-0 z-40 w-[28rem] max-w-full bg-white border-l border-slate-200 shadow-xl flex flex-col transform transition-transform duration-300 ${
                    open ? 'translate-x-0' : 'translate-x-full pointer-events-none'
                }`}
            >
                {/* Dark chrome header — echo of the app's slate-800 band */}
                <header className="bg-slate-800 text-white px-4 py-3 flex items-center justify-between gap-3">
                    <div>
                        <p className="text-sm font-semibold flex items-center gap-2">
                            <MessageCircle className="w-4 h-4" />
                            Ask the record
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                            Answers only from this patient&rsquo;s record — every claim cited
                        </p>
                    </div>
                    <button
                        type="button"
                        aria-label="Close chat"
                        onClick={() => onToggle(false)}
                        className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </header>

                <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
                    {historyLoading && <p className="text-sm text-slate-400 text-center py-4">Loading conversation…</p>}
                    {historyError !== null && (
                        <p className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">{historyError}</p>
                    )}
                    {!historyLoading && bubbles.length === 0 && (
                        <div className="text-center py-8">
                            <MessageCircle className="w-8 h-8 mx-auto mb-3 text-slate-300" />
                            <p className="text-sm font-medium text-slate-500">Ask anything about this record</p>
                            <p className="text-xs text-slate-400 mt-1">Replies cite the source documents, chip by chip.</p>
                            <div className="mt-4 flex flex-wrap justify-center gap-2">
                                {QUICK_PROMPTS.map((prompt) => (
                                    <button
                                        key={prompt}
                                        type="button"
                                        onClick={() => send(prompt)}
                                        className="px-3 py-1.5 rounded-full border border-slate-200 bg-slate-50 text-xs text-slate-600 hover:bg-slate-100 transition-colors"
                                    >
                                        {prompt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {bubbles.map((bubble) =>
                        bubble.role === 'user' ? (
                            <div key={bubble.id} className="flex justify-end">
                                <div className="max-w-[85%] rounded-xl rounded-br-sm bg-blue-600 text-white px-3.5 py-2 text-[13px] leading-snug whitespace-pre-wrap">
                                    {bubble.content}
                                </div>
                            </div>
                        ) : (
                            <AssistantBubble key={bubble.id} bubble={bubble} onRetry={retry} images={images} {...(onOpenScan === undefined ? {} : { onOpenScan })} />
                        ),
                    )}
                </div>

                <div className="border-t border-slate-200 p-3">
                    <div className="flex items-end gap-2">
                        <textarea
                            ref={inputRef}
                            rows={1}
                            maxLength={MAX_MESSAGE_CHARS}
                            value={draft}
                            disabled={sending}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="Ask about this patient's record…"
                            aria-label="Chat message"
                            className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
                        />
                        <button
                            type="button"
                            aria-label="Send message"
                            disabled={sending || draft.trim() === ''}
                            onClick={() => send(draft)}
                            className="p-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-400">
                        Enter to send · Shift+Enter for a new line
                        {draft.length >= MAX_MESSAGE_CHARS - 200 && ` · ${MAX_MESSAGE_CHARS - draft.length} characters left`}
                    </p>
                </div>
            </aside>
        </>
    );
}
