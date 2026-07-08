// Chat drawer tests (S2.3): scripted SSE streams over a mocked fetch — delta accumulation,
// done-event citation gating (valid ids -> chips, unverifiable removed + amber footer),
// pre-stream guard rejections (429 budget), history replay on reopen, quick-prompt sends.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import ChatDrawer from '../ChatDrawer';
import { briefContent } from './fixtures';

// ---- Harness: ChatDrawer with the lifted open state App owns ----

function Harness({ patientId = 'margaret-chen' }: { patientId?: string }) {
    const [open, setOpen] = useState(false);
    return <ChatDrawer patientId={patientId} factsByType={briefContent.facts_by_type} open={open} onToggle={setOpen} />;
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

afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
});

describe('ChatDrawer streaming', () => {
    // Failure mode: deltas overwrite instead of accumulate, or the done event's citation
    // gate is ignored and invented [[fact:...]] tokens render as provenance chips.
    it('accumulates streamed deltas and finalizes with chips for valid citation ids only', async () => {
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
            controller.enqueue(sseChunk({ type: 'delta', text: 'On hydroxychloroquine 200mg daily ' }));
        });
        expect(await screen.findByText(/On hydroxychloroquine 200mg daily/)).toBeInTheDocument();
        // Input stays locked while the reply streams.
        expect(screen.getByLabelText('Chat message')).toBeDisabled();

        await act(async () => {
            controller.enqueue(
                sseChunk({
                    type: 'delta',
                    text: '[[fact:fact-mc-med-001]] with floaters reported [[fact:fact-mc-cc-001]] plus an invented claim [[fact:fact-invented]].',
                }),
            );
            controller.enqueue(
                sseChunk({
                    type: 'done',
                    conversation_id: 'conv-1',
                    cited_fact_ids: ['fact-mc-med-001', 'fact-mc-cc-001'],
                    invalid_citation_ids: ['fact-invented'],
                }),
            );
            controller.close();
        });

        // Valid ids become numbered chips resolved against the overview facts …
        expect(
            await screen.findByRole('button', { name: 'Citation 1: Rheumatology office note - Dr. Anita Patel' }),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Citation 2: Conversational intake transcript' })).toBeInTheDocument();
        // … and no raw token ever reaches the DOM (the invented one is removed, not rendered).
        expect(screen.queryByText(/\[\[fact:/)).not.toBeInTheDocument();
        expect(screen.queryByText(/fact-invented/)).not.toBeInTheDocument();
        // The conversation id is persisted per patient, and the input unlocks.
        await waitFor(() => expect(window.sessionStorage.getItem('copilot.chat.margaret-chen')).toBe('conv-1'));
        expect(screen.getByLabelText('Chat message')).not.toBeDisabled();
    });

    // Failure mode: invented citations disappear silently — the doctor must see that
    // part of the reply failed verification against the record.
    it('shows the amber unverified-citation footer when the done event reports invalid ids', async () => {
        stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    {
                        type: 'delta',
                        text: 'Allergy documented [[fact:fact-mc-allergy-001]] but also [[fact:ghost-1]] and [[fact:ghost-2]].',
                    },
                    {
                        type: 'done',
                        conversation_id: 'conv-2',
                        cited_fact_ids: ['fact-mc-allergy-001'],
                        invalid_citation_ids: ['ghost-1', 'ghost-2'],
                    },
                ]);
            }
            return undefined;
        });
        render(<Harness />);
        openDrawer();
        sendMessage('Any allergies?');

        expect(await screen.findByText('2 citations could not be verified against the record')).toBeInTheDocument();
        // The verified claim still chips (synthesized ref: the allergy fact has no sources).
        expect(screen.getByRole('button', { name: 'Citation 1: Allergy' })).toBeInTheDocument();
        expect(screen.queryByText(/ghost/)).not.toBeInTheDocument();
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
                          { type: 'done', conversation_id: 'conv-4', cited_fact_ids: [], invalid_citation_ids: [] },
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

describe('ChatDrawer persistence', () => {
    // Failure mode: reopening the panel loses the conversation — the stored id must
    // replay its history via GET, tokens re-resolving into chips client-side.
    it('replays stored conversation history via GET when reopened with a stored id', async () => {
        window.sessionStorage.setItem('copilot.chat.margaret-chen', 'conv-9');
        const mock = stubFetch((url, init) => {
            if (url.includes('/api/chat/margaret-chen?conversation_id=conv-9') && init?.method !== 'POST') {
                return jsonResponse(200, {
                    conversation_id: 'conv-9',
                    messages: [
                        { role: 'user', content: 'Why is she here?', created_at: '2024-12-26T10:00:00Z' },
                        {
                            role: 'assistant',
                            content: 'Floaters and flashes x 2-3 weeks, worse OD [[fact:fact-mc-cc-001]]',
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
        // Replayed tokens resolve into chips against the overview facts.
        expect(screen.getByRole('button', { name: 'Citation 1: Conversational intake transcript' })).toBeInTheDocument();
        expect(mock.mock.calls.some(([input]) => String(input).includes('conversation_id=conv-9'))).toBe(true);
    });

    // Failure mode: closing the drawer drops the in-memory conversation or re-fetches
    // history on every open.
    it('preserves the conversation across close/reopen without re-fetching history', async () => {
        const mock = stubFetch((url, init) => {
            if (url.includes('/api/chat/') && init?.method === 'POST') {
                return sseResponse([
                    { type: 'delta', text: 'Still here.' },
                    { type: 'done', conversation_id: 'conv-5', cited_fact_ids: [], invalid_citation_ids: [] },
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
                    { type: 'done', conversation_id: 'conv-3', cited_fact_ids: [], invalid_citation_ids: [] },
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
