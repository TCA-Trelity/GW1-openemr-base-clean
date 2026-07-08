// Chat drawer (S2.3): the docked "Ask the record" slide-over, reachable from every tab.
// Replies stream over POST /api/chat SSE; inline [[fact:<id>]] tokens render as the shared
// numbered CitationChip resolved against the overview's facts — unverifiable ones are removed.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, MessageCircle, RefreshCw, Send, X } from 'lucide-react';
import { fetchChatHistory, sendChatMessage } from './api';
import type { CitationRef, FactType, PatientFact } from './types';
import { CitationChip } from './CitationChip';
import { titleCase } from './ui';

const MAX_MESSAGE_CHARS = 2000; // mirrors routes/chat.ts MAX_MESSAGE_CHARS

const QUICK_PROMPTS = [
    'What brings her in today?',
    'Any medication risks?',
    'What changed since the last visit?',
    'Summarize the contradictions in the record.',
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
    status: 'complete' | 'streaming' | 'error';
    /** null until the done event lands — and for replayed history, which carries no ids. */
    citedFactIds: string[] | null;
    invalidCitationIds: string[];
    /** The user message that produced this assistant bubble — what Retry resends. */
    requestText: string;
    errorText: string | null;
}

let nextBubbleSeq = 0;
function bubbleId(prefix: string): string {
    nextBubbleSeq += 1;
    return `${prefix}-${nextBubbleSeq}`;
}

// ---- Citation token rendering ----

const CITATION_TOKEN = /\[\[fact:([A-Za-z0-9._-]+)\]\]/g;

/** In partial replies (streaming/interrupted), hide a trailing half-received token so it never shows raw. */
function visibleText(content: string, partial: boolean): string {
    return partial ? content.replace(/\[\[[^\]]*\]?$/, '') : content;
}

/** The chip renders a CitationRef: the fact's own first source, else a minimal synthesized one. */
function chipCitation(fact: PatientFact): CitationRef {
    return (
        fact.sources[0] ?? {
            id: `chat-cit-${fact.id}`,
            fact_id: fact.id,
            source_label: titleCase(fact.fact_type),
            source_type: 'provider_note',
            excerpt_text: null,
            excerpt_location: null,
            attribution: null,
            source_document_id: fact.source_document_id,
            document_date: fact.created_date ?? null,
        }
    );
}

interface RenderedReply {
    nodes: ReactNode[];
    /** Distinct citation ids removed because they could not be verified against the record. */
    unverifiedCount: number;
}

/**
 * Replace each VERIFIABLE [[fact:<id>]] token with a numbered CitationChip and remove the
 * rest — an unverifiable citation is never rendered as a chip. Verifiable = not reported in
 * invalid_citation_ids, resolvable against the overview's facts, and (once the done event
 * has landed) present in cited_fact_ids. While citedFactIds is null (mid-stream, or replayed
 * history which carries no ids) resolvable tokens render optimistically.
 */
export function renderAssistantReply(
    content: string,
    factById: Map<string, PatientFact>,
    citedFactIds: string[] | null,
    invalidCitationIds: string[],
    partial: boolean,
): RenderedReply {
    const text = visibleText(content, partial);
    const cited = citedFactIds === null ? null : new Set(citedFactIds);
    const invalid = new Set(invalidCitationIds);
    const nodes: ReactNode[] = [];
    const chipNumbers = new Map<string, number>();
    const removed = new Set<string>();
    let cursor = 0;
    let key = 0;
    for (const match of text.matchAll(CITATION_TOKEN)) {
        const id = match[1];
        const start = match.index ?? -1;
        if (id === undefined || start < 0) {
            continue;
        }
        let before = text.slice(cursor, start);
        cursor = start + match[0].length;
        const fact = factById.get(id);
        const verifiable = fact !== undefined && !invalid.has(id) && (cited === null || cited.has(id));
        if (!verifiable) {
            removed.add(id);
            before = before.replace(/[ \t]+$/, ''); // no dangling double space where the token sat
            if (before !== '') {
                nodes.push(<span key={key++}>{before}</span>);
            }
            continue;
        }
        if (before !== '') {
            nodes.push(<span key={key++}>{before}</span>);
        }
        const number = chipNumbers.get(id) ?? chipNumbers.size + 1;
        chipNumbers.set(id, number);
        nodes.push(<CitationChip key={key++} citation={chipCitation(fact)} index={number} />);
    }
    const tail = text.slice(cursor);
    if (tail !== '') {
        nodes.push(<span key={key++}>{tail}</span>);
    }
    return { nodes, unverifiedCount: removed.size };
}

// ---- Bubbles ----

function AssistantBubble({
    bubble,
    factById,
    onRetry,
}: {
    bubble: ChatBubble;
    factById: Map<string, PatientFact>;
    onRetry: (bubble: ChatBubble) => void;
}) {
    const { nodes, unverifiedCount } = useMemo(
        () =>
            renderAssistantReply(
                bubble.content,
                factById,
                bubble.citedFactIds,
                bubble.invalidCitationIds,
                bubble.status !== 'complete',
            ),
        [bubble, factById],
    );
    return (
        <div className="flex justify-start">
            <div className="max-w-[85%]">
                {(nodes.length > 0 || bubble.status === 'streaming') && (
                    <div className="rounded-xl rounded-bl-sm bg-slate-100 px-3.5 py-2.5 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                        {nodes}
                        {bubble.status === 'streaming' && (
                            <span
                                data-testid="chat-streaming"
                                className="inline-block w-1.5 h-3.5 ml-0.5 align-middle rounded-sm bg-slate-400 animate-pulse"
                            />
                        )}
                    </div>
                )}
                {bubble.status === 'complete' && unverifiedCount > 0 && (
                    <p className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-xs text-amber-700">
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                        {unverifiedCount} citation{unverifiedCount === 1 ? '' : 's'} could not be verified against the record
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
    factsByType,
    open,
    onToggle,
}: {
    patientId: string;
    /** The already-fetched overview's facts_by_type — the token -> fact resolution source. */
    factsByType: Partial<Record<FactType, PatientFact[]>>;
    open: boolean;
    onToggle: (open: boolean) => void;
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

    const factById = useMemo(() => {
        const map = new Map<string, PatientFact>();
        for (const group of Object.values(factsByType)) {
            for (const fact of group ?? []) {
                map.set(fact.id, fact);
            }
        }
        return map;
    }, [factsByType]);

    // First open with a stored conversation id: replay its history via GET.
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
                                  citedFactIds: null,
                                  invalidCitationIds: [],
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

    const patch = useCallback((id: string, update: (bubble: ChatBubble) => ChatBubble) => {
        setBubbles((prev) => prev.map((bubble) => (bubble.id === id ? update(bubble) : bubble)));
    }, []);

    /** One streamed turn against an already-appended assistant placeholder bubble. */
    const run = useCallback(
        async (text: string, assistantId: string) => {
            sendingRef.current = true;
            setSending(true);
            const result = await sendChatMessage(patientId, text, conversationIdRef.current, (delta) => {
                patch(assistantId, (bubble) => ({ ...bubble, content: bubble.content + delta }));
            });
            if (result.kind === 'done') {
                conversationIdRef.current = result.done.conversationId;
                storeConversationId(patientId, result.done.conversationId);
                patch(assistantId, (bubble) => ({
                    ...bubble,
                    status: 'complete',
                    citedFactIds: result.done.citedFactIds,
                    invalidCitationIds: result.done.invalidCitationIds,
                }));
            } else if (result.kind === 'stream_error') {
                patch(assistantId, (bubble) => ({ ...bubble, status: 'error', errorText: 'The reply was interrupted.' }));
            } else {
                patch(assistantId, (bubble) => ({ ...bubble, status: 'error', errorText: result.message }));
            }
            sendingRef.current = false;
            setSending(false);
        },
        [patientId, patch],
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
                    citedFactIds: null,
                    invalidCitationIds: [],
                    requestText: '',
                    errorText: null,
                },
                {
                    id: assistantId,
                    role: 'assistant',
                    content: '',
                    status: 'streaming',
                    citedFactIds: null,
                    invalidCitationIds: [],
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
                citedFactIds: null,
                invalidCitationIds: [],
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
                            <p className="text-xs text-slate-400 mt-1">Replies cite the underlying facts, chip by chip.</p>
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
                                <div className="max-w-[85%] rounded-xl rounded-br-sm bg-blue-600 text-white px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                                    {bubble.content}
                                </div>
                            </div>
                        ) : (
                            <AssistantBubble key={bubble.id} bubble={bubble} factById={factById} onRetry={retry} />
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
