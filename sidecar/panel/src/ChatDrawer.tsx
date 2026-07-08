// Chat drawer (S2.3, R5 native citations): the docked "Ask the record" slide-over,
// reachable from every tab. Replies stream over POST /api/chat SSE as clean prose — no
// inline tokens. Provenance rides the stream's citation events (already server-verified
// verbatim against the stored documents): verified citations render as source-labelled
// chips appended to the bubble, deep-linking into the source viewer at the cited character
// range; unverified ones are never rendered as chips, only counted in the amber footer.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, MessageCircle, RefreshCw, Send, X } from 'lucide-react';
import { fetchChatHistory, sendChatMessage } from './api';
import type { ChatCitation, CitationRef } from './types';
import { CitationChips } from './CitationChip';
import { asSourceType, titleCase } from './ui';

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
    /** Streamed citations in arrival order, deduped — replayed history carries none. */
    citations: ChatCitation[];
    /** From the done event; unverifiable spans are surfaced here, never as chips. */
    unverifiedCount: number;
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

// ---- Bubbles ----

function AssistantBubble({ bubble, onRetry }: { bubble: ChatBubble; onRetry: (bubble: ChatBubble) => void }) {
    // Chips: verified citations only, in arrival order — an unverifiable citation is never provenance.
    const chips = useMemo(
        () => bubble.citations.filter((citation) => citation.verified).map(chatCitationRef),
        [bubble.citations],
    );
    return (
        <div className="flex justify-start">
            <div className="max-w-[85%]">
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
}: {
    patientId: string;
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
            );
            if (result.kind === 'done') {
                conversationIdRef.current = result.done.conversationId;
                storeConversationId(patientId, result.done.conversationId);
                patch(assistantId, (bubble) => ({
                    ...bubble,
                    status: 'complete',
                    citations: dedupeCitations(result.done.citations),
                    unverifiedCount: result.done.unverifiedCount,
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
                    citations: [],
                    unverifiedCount: 0,
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
                            <AssistantBubble key={bubble.id} bubble={bubble} onRetry={retry} />
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
