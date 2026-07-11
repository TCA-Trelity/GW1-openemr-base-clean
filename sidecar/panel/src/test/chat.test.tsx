// Chat drawer tests (S2.3, R5 native citations): scripted SSE streams over a mocked
// fetch — delta accumulation over clean prose, live citation events rendering as
// source-labelled chips (verified only, deduped by document+start), the amber unverified
// footer from the done event, the chip -> source-viewer deep link, pre-stream guard
// rejections (429 budget), history replay on reopen (text only), quick-prompt sends.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import ChatDrawer from '../ChatDrawer';
import { SourceNavContext } from '../CitationChip';
import type { CitationRef } from '../types';

// ---- Harness: ChatDrawer with the lifted open state App owns ----

function Harness({ patientId = 'margaret-chen', onViewSource }: { patientId?: string; onViewSource?: (citation: CitationRef) => void }) {
    const [open, setOpen] = useState(false);
    const drawer = <ChatDrawer patientId={patientId} open={open} onToggle={setOpen} />;
    return onViewSource === undefined ? drawer : <SourceNavContext.Provider value={onViewSource}>{drawer}</SourceNavContext.Provider>;
}

// ---- Fetch stubbing: JSON guards + SSE stream bodies ----

const encoder = new TextEncoder();

function sseChunk(event: Record<string, unknown>): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** A Response whose body is the scripted SSE events, delivered as one closed stream. */
function sseResponse(events: Record<string, unknown>[]): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const event of events) {
                controller.enqueue(sseChunk(event));
            }
            controller.close();
        },
    });
    return { ok: true, status: 200, body } as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(handler: Handler) {
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const result = handler(url, init);
        if (result === undefined) {
            throw new Error(`unstubbed fetch: ${url}`);
        }
        return result;
    });
    vi.stubGlobal('fetch', mock);
    return mock;
}

function openDrawer() {
    fireEvent.click(screen.getByRole('button', { name: /Ask the record/i }));
}

function sendMessage(text: string) {
    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: text } });
    fireEvent.keyDown(screen.getByLabelText('Chat message'), { key: 'Enter' });
}

// ---- Wire-shaped citations (chat/chat.ts ChatCitation) ----

const hcqChatCitation = {
    document_id: 'doc-mc-003',
    document_title: 'clinical_note (2024-09-10)',
    cited_text: 'Hydroxychloroquine 200mg PO daily - initiated 01/15/2019',
    start_char: 421,
    end_char: 477,
    verified: true,
};

const intakeChatCitation = {
    document_id: 'doc-mc-012',
    document_title: 'intake_transcript (2024-12-26)',
    cited_text: "I've been seeing these floaters in my vision, especially in my right eye.",
    start_char: 130,
    end_char: 204,
    verified: true,
};

const ghostChatCitation = {
    document_id: 'doc-mc-001',
    document_title: 'referral_letter (2024-12-15)',
    cited_text: 'a span that is not in our copy of the document',
    start_char: -1,
    end_char: -1,
    verified: false,
};

afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
});

describe('ChatDrawer streaming', () => {
    // Failure mode: deltas overwrite instead of accumulate, citation events are dropped
    // (or duplicated), or unverified citations render as provenance chips.
    it('accumulates deltas and renders live citation events as chips — verified only, deduped', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
        });
        stubFetch((url, init) => {
            if (url.includes('/api/chat/margaret-chen') && init?.method === 'POST') {
                return { ok: true, status: 200, body } as unknown as Response;
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('What is she taking?');

        // The user bubble lands immediately; the reply streams into the assistant bubble.
        expect(screen.getByText('What is she taking?')).toBeInTheDocument();
        await act(async () => {
            controller.enqueue(sseChunk({ type: 'delta', text: 'On hydroxychloroquine 200mg daily' }));
        });
        expect(await screen.findByText(/On hydroxychloroquine 200mg daily/)).toBeInTheDocument();
        // Input stays locked while the reply streams.
        expect(screen.getByLabelText('Chat message')).toBeDisabled();

        // Citations stream live — the chip renders before the done event, labelled with
        // the document type parsed from document_title (R8), not a number.
        await act(async () => {
            controller.enqueue(sseChunk({ type: 'citation', citation: hcqChatCitation }));
        });
        const clinicalNoteChip = await screen.findByRole('button', { name: 'Citation 1: Clinical Note' });
        expect(clinicalNoteChip).toHaveTextContent('Clinical note');
        expect(clinicalNoteChip.textContent).not.toMatch(/\d/);

        await act(async () => {
            controller.enqueue(sseChunk({ type: 'delta', text: ' with new floaters reported at intake.' }));
            // Duplicate (same document_id+start_char) must not mint a second chip.
            controller.enqueue(sseChunk({ type: 'citation', citation: hcqChatCitation }));
            controller.enqueue(sseChunk({ type: 'citation', citation: intakeChatCitation }));
            // Unverified citations are never rendered as chips.
            controller.enqueue(sseChunk({ type: 'citation', citation: ghostChatCitation }));
            controller.enqueue(
                sseChunk({
                    type: 'done',
                    conversation_id: 'conv-1',
                    citations: [hcqChatCitation, hcqChatCitation, intakeChatCitation, ghostChatCitation],
                    unverified_count: 1,
                }),
            );
            controller.close();
        });

        // Labelled chips in arrival order, deduped; the unverified one is only a count.
        expect(await screen.findByRole('button', { name: 'Citation 2: Intake Transcript' })).toHaveTextContent('Intake');
        expect(screen.getAllByRole('button', { name: /^Citation \d/ })).toHaveLength(2);
        expect(screen.getByText('1 citation could not be verified')).toBeInTheDocument();
        expect(screen.queryByText(/referral_letter/)).not.toBeInTheDocument();
        // The conversation id is persisted per patient, and the input unlocks.
        await waitFor(() => expect(window.sessionStorage.getItem('copilot.chat.margaret-chen')).toBe('conv-1'));
        expect(screen.getByLabelText('Chat message')).not.toBeDisabled();
    });

    // Failure mode: the chip is decorative — it must deep-link into the existing source
    // viewer at the cited document + character range.
    it('deep-links a citation chip into the source viewer with the cited range', async () => {
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    { type: 'delta', text: 'On hydroxychloroquine 200mg daily since January 2019.' },
                    { type: 'citation', citation: hcqChatCitation },
                    { type: 'done', conversation_id: 'conv-2', citations: [hcqChatCitation], unverified_count: 0 },
                ]);
            }
            return undefined;
        });
        const viewSource = vi.fn();
        render(<Harness onViewSource={viewSource} />);
        openDrawer();
        sendMessage('How long on HCQ?');

        fireEvent.click(await screen.findByRole('button', { name: 'Citation 1: Clinical Note' }));
        const card = await screen.findByRole('dialog');
        // The popover shows the verbatim cited span and the parsed document date.
        expect(within(card).getByText(/Hydroxychloroquine 200mg PO daily - initiated 01\/15\/2019/)).toBeInTheDocument();
        expect(within(card).getByText('Sep 10, 2024')).toBeInTheDocument();
        fireEvent.click(within(card).getByRole('button', { name: /View source/i }));
        expect(viewSource).toHaveBeenCalledWith(
            expect.objectContaining({
                source_document_id: 'doc-mc-003',
                excerpt_text: hcqChatCitation.cited_text,
                excerpt_location: expect.objectContaining({ start_char: 421, end_char: 477 }),
            }),
        );
    });

    // Failure mode: invented citations disappear silently — the doctor must see that
    // part of the reply failed verification against the record.
    it('shows the amber unverified footer without rendering any chip for unverified citations', async () => {
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    { type: 'delta', text: 'Sulfa allergy documented at intake; the referral disagrees.' },
                    { type: 'citation', citation: intakeChatCitation },
                    { type: 'citation', citation: ghostChatCitation },
                    { type: 'citation', citation: { ...ghostChatCitation, start_char: 55 } },
                    {
                        type: 'done',
                        conversation_id: 'conv-3',
                        citations: [intakeChatCitation, ghostChatCitation, { ...ghostChatCitation, start_char: 55 }],
                        unverified_count: 2,
                    },
                ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('Any allergies?');

        expect(await screen.findByText('2 citations could not be verified')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /^Citation \d/ })).toHaveLength(1);
        expect(screen.getByRole('button', { name: 'Citation 1: Intake Transcript' })).toBeInTheDocument();
    });

    // Failure mode: a guard rejection wedges the input or renders a raw HTTP error.
    it('renders the budget message on 429 and re-enables the input', async () => {
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return jsonResponse(429, { error: 'llm_budget_exceeded', spent_usd: 5, budget_usd: 5 });
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('Any medication risks?');

        expect(await screen.findByText('Daily AI budget reached — try tomorrow')).toBeInTheDocument();
        expect(screen.getByLabelText('Chat message')).not.toBeDisabled();
        expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    });

    // Failure mode: an in-stream error event leaves a forever-spinning bubble with no
    // way to retry that turn.
    it('shows a retry affordance on an in-stream error event, and Retry resends the turn', async () => {
        let calls = 0;
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                calls += 1;
                return calls === 1
                    ? sseResponse([{ type: 'delta', text: 'Partial answer' }, { type: 'error', error: 'chat_failed' }])
                    : sseResponse([
                          { type: 'delta', text: 'Full answer.' },
                          { type: 'done', conversation_id: 'conv-4', citations: [], unverified_count: 0 },
                      ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('Tell me about imaging.');

        expect(await screen.findByText('The reply was interrupted.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
        expect(await screen.findByText('Full answer.')).toBeInTheDocument();
        expect(screen.queryByText('The reply was interrupted.')).not.toBeInTheDocument();
    });
});

describe('ChatDrawer tool activity (TC3)', () => {
    // Failure mode: the model invokes tools but the drawer shows nothing — tool use must be
    // visible in the demo, each chip labelled with a friendly name + input hint and marked
    // done when its result arrives.
    it('renders a chip per tool as it streams, with an input hint, and settles them to done', async () => {
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    { type: 'tool_use', name: 'search_record', input: { query: 'sulfa allergy' } },
                    { type: 'tool_result', name: 'search_record', ok: true },
                    { type: 'tool_use', name: 'get_measurement_trend', input: { metric: 'IOP', laterality: 'OD' } },
                    { type: 'tool_result', name: 'get_measurement_trend', ok: true },
                    { type: 'delta', text: 'Sulfa allergy is documented at intake; IOP trending down OD.' },
                    { type: 'citation', citation: intakeChatCitation },
                    {
                        type: 'done',
                        conversation_id: 'conv-tc3',
                        citations: [intakeChatCitation],
                        unverified_count: 0,
                        tools_used: ['search_record', 'get_measurement_trend'],
                    },
                ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('Any allergies, and how is her pressure?');

        const strip = await screen.findByTestId('tool-activity');
        // Friendly labels, not raw tool names; the input hint rides alongside.
        expect(within(strip).getByText('Searched the record')).toBeInTheDocument();
        expect(within(strip).getByText('sulfa allergy')).toBeInTheDocument();
        expect(within(strip).getByText('Traced measurement trend')).toBeInTheDocument();
        expect(within(strip).queryByText('search_record')).not.toBeInTheDocument();

        // Both chips settle to done (no spinner left) once the turn completes.
        await waitFor(() => {
            const chips = within(strip).getAllByTestId('tool-chip');
            expect(chips).toHaveLength(2);
            for (const chip of chips) {
                expect(chip).toHaveAttribute('data-status', 'ok');
            }
        });
        // The final answer + its citation still render normally beneath the strip.
        expect(await screen.findByText(/Sulfa allergy is documented at intake/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Citation 1: Intake Transcript' })).toBeInTheDocument();
    });

    // Failure mode: a tool that returned a structured error reads as success — graceful
    // degradation must be visible, so a failed tool renders distinctly (amber + alert).
    it('marks a tool that returned no result as failed', async () => {
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    { type: 'tool_use', name: 'get_full_document', input: { document_id: 'doc-missing' } },
                    { type: 'tool_result', name: 'get_full_document', ok: false },
                    { type: 'delta', text: 'I could not find that document in the record.' },
                    { type: 'done', conversation_id: 'conv-tc3b', citations: [], unverified_count: 0, tools_used: ['get_full_document'] },
                ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('Open document doc-missing');

        const chip = await within(await screen.findByTestId('tool-activity')).findByTestId('tool-chip');
        await waitFor(() => expect(chip).toHaveAttribute('data-status', 'error'));
        expect(chip).toHaveTextContent('Read full document');
    });
});

describe('ChatDrawer persistence', () => {
    // Failure mode: reopening the panel loses the conversation — the stored id must
    // replay its history via GET. Replayed messages carry no citations: text only.
    it('replays stored conversation history via GET as text-only bubbles', async () => {
        window.sessionStorage.setItem('copilot.chat.margaret-chen', 'conv-9');
        const mock = stubFetch((url, init) => {
            if (url.includes('/api/chat/margaret-chen?conversation_id=conv-9') && init?.method !== 'POST') {
                return jsonResponse(200, {
                    conversation_id: 'conv-9',
                    messages: [
                        { role: 'user', content: 'Why is she here?', created_at: '2024-12-26T10:00:00Z' },
                        {
                            role: 'assistant',
                            content: 'Floaters and flashes x 2-3 weeks, worse OD.',
                            created_at: '2024-12-26T10:00:05Z',
                        },
                    ],
                });
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();

        expect(await screen.findByText('Why is she here?')).toBeInTheDocument();
        expect(screen.getByText(/Floaters and flashes x 2-3 weeks, worse OD/)).toBeInTheDocument();
        // No citation chips and no unverified footer on replayed history.
        expect(screen.queryByRole('button', { name: /^Citation \d/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/could not be verified/)).not.toBeInTheDocument();
        expect(mock.mock.calls.some(([input]) => String(input).includes('conversation_id=conv-9'))).toBe(true);
    });

    // Failure mode: closing the drawer drops the in-memory conversation or re-fetches
    // history on every open.
    it('preserves the conversation across close/reopen without re-fetching history', async () => {
        const mock = stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    { type: 'delta', text: 'Still here.' },
                    { type: 'done', conversation_id: 'conv-5', citations: [], unverified_count: 0 },
                ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('Are you keeping state?');
        expect(await screen.findByText('Still here.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
        openDrawer();
        expect(screen.getByText('Still here.')).toBeInTheDocument();
        // One POST, zero history GETs — reopening replays from memory.
        expect(mock.mock.calls).toHaveLength(1);
    });
});

describe('ChatDrawer quick prompts', () => {
    // Failure mode: the empty-state chips are decorative — clicking one must send that
    // exact message as the turn.
    it('sends the quick prompt as the message when its chip is clicked', async () => {
        const mock = stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    { type: 'delta', text: 'No high-risk interactions in the record.' },
                    { type: 'done', conversation_id: 'conv-6', citations: [], unverified_count: 0 },
                ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        fireEvent.click(screen.getByRole('button', { name: 'Any medication risks?' }));

        expect(await screen.findByText('No high-risk interactions in the record.')).toBeInTheDocument();
        // The prompt became the user bubble and the POST body's message.
        expect(screen.getByText('Any medication risks?')).toBeInTheDocument();
        const post = mock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
        expect(post).toBeDefined();
        expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ message: 'Any medication risks?' });
    });
});

describe('ChatDrawer ask-about-this seeding (M6)', () => {
    // Failure modes: a seeded ask silently not reaching the input, or worse, auto-sending
    // a turn (spending tokens) without the physician's keystroke.
    function SeedHarness({ seedText }: { seedText: string }) {
        const [open, setOpen] = useState(false);
        const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
        return (
            <>
                <button
                    type="button"
                    onClick={() => {
                        setSeed({ text: seedText, nonce: 1 });
                        setOpen(true);
                    }}
                >
                    seed-ask
                </button>
                <ChatDrawer patientId="margaret-chen" open={open} onToggle={setOpen} seed={seed} />
            </>
        );
    }

    it('opens the pane with the ask prefilled — and never auto-sends it', async () => {
        const mock = stubFetch(() => jsonResponse(200, { conversation_id: 'x', messages: [] }));
        const seedText = 'About the Oct 22, 2025 OD scan: what changed compared with the prior scan?';
        render(<SeedHarness seedText={seedText} />);

        fireEvent.click(screen.getByRole('button', { name: 'seed-ask' }));

        const input = await screen.findByPlaceholderText("Ask about this patient's record…");
        expect((input as HTMLTextAreaElement).value).toBe(seedText);
        // Prefill only: no chat POST fired without the physician's send.
        const post = mock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
        expect(post).toBeUndefined();
    });
});

describe('ChatDrawer opening move (M9)', () => {
    // Failure mode: the seed event not rendering, or rendering below the first exchange —
    // the transcript must open with the agent's prepared digest, labelled as such.
    it('renders the seeded opening move above the first exchange', async () => {
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    {
                        type: 'seed',
                        conversation_id: 'conv-9',
                        content: 'I read the record during check-in (brief prepared 2026-07-11). Ask me to drill in.',
                    },
                    { type: 'delta', text: 'Plaquenil 200 mg daily.' },
                    { type: 'done', conversation_id: 'conv-9', citations: [], unverified_count: 0 },
                ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        fireEvent.click(screen.getByRole('button', { name: 'Any medication risks?' }));

        const opening = await screen.findByText(/I read the record during check-in/);
        expect(screen.getByText('Opening move — prepared during check-in')).toBeInTheDocument();
        expect(await screen.findByText('Plaquenil 200 mg daily.')).toBeInTheDocument();
        // DOM order: the opening move precedes the user's first bubble.
        const userBubble = screen.getByText('Any medication risks?');
        expect(opening.compareDocumentPosition(userBubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
