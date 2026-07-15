// Eval: imaging-cohesion (IC0/IC1/IC4). The chat surface and the analytics rail must tell ONE
// imaging story. IC1's get_imaging_overview returns the SAME derived block buildOverview
// feeds the panel — these evals pin that contract (deep-equal, per corpus) and prove the
// tool rides the real ChatService loop verbatim. A third, opt-in case (LIVE_EVALS=1 + API
// key) replays the observed failure that motivated IC0 — "how are her scans trending?"
// answered with a false absence claim — and requires the real model to consult an imaging
// tool instead.
import { isDeepStrictEqual } from 'node:util';
import { describe, it } from 'vitest';
import { ChatService, type ChatMessageInput, type ChatStore, type StoredChatMessage } from '../src/chat/chat.js';
import { getImagingOverview } from '../src/chat/tools/index.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import type { PrepLogger } from '../src/prep/extraction.js';
import { buildOverview } from '../src/routes/overview.js';
import { recordEval } from './collector.js';
import { margaretChen, seededFactBundle, williamThompson } from './corpus.js';
import { llmResponse, llmToolUseResponse } from './sse.js';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

class MemoryChatStore implements ChatStore {
    readonly rows: (StoredChatMessage & { patient_id: string })[] = [];
    saveChatMessage(input: ChatMessageInput): Promise<string> {
        const id = `msg-${this.rows.length + 1}`;
        this.rows.push({ ...input, id, created_at: `2026-07-11T00:00:0${this.rows.length}Z` });
        return Promise.resolve(id);
    }
    getChatMessages(patientId: string, conversationId: string, limit = 20): Promise<StoredChatMessage[]> {
        return Promise.resolve(
            this.rows
                .filter((row) => row.patient_id === patientId && row.conversation_id === conversationId)
                .slice(-limit),
        );
    }
}

function scriptedClient(responses: Response[]): {
    client: AnthropicClient;
    requests: Record<string, unknown>[];
} {
    const requests: Record<string, unknown>[] = [];
    const queue = [...responses];
    const fetchImpl: FetchLike = (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const next = queue.shift();
        if (next === undefined) {
            throw new Error('scripted client exhausted — the loop made more calls than scripted');
        }
        return Promise.resolve(next);
    };
    return { client: new AnthropicClient({ apiKey: 'eval-key', model: 'claude-haiku-4-5', fetchImpl }), requests };
}

// The imaging block never reads the clock (all arithmetic is over stored dates), so any
// fixed `now` proves the point; a varying one would make the eval flaky if that changed.
const FIXED_NOW = new Date('2026-07-11T00:00:00Z');

describe('imaging-cohesion', () => {
    it('chat tool and analytics rail derive from one source of truth, per corpus', () => {
        const corpora = [
            { name: 'margaret-chen', corpus: margaretChen, scans: 6, first: '2021-12-15T14:00:00Z', latest: '2024-12-26T10:35:00Z' },
            { name: 'william-thompson', corpus: williamThompson, scans: 7, first: '2025-05-05T10:30:00Z', latest: '2025-12-10T09:40:00Z' },
        ];

        const verdicts = corpora.map(({ name, corpus, scans, first, latest }) => {
            const bundle = seededFactBundle(corpus);
            const inv = getImagingOverview.invoke(bundle, {});
            const overviewImaging = (buildOverview(bundle, null, FIXED_NOW) as {
                imaging: { timeline_summary: unknown; interval_analysis: unknown; hcq_progression: unknown };
            }).imaging;

            const cohesive =
                inv.ok &&
                isDeepStrictEqual(inv.output['timeline'], overviewImaging.timeline_summary) &&
                isDeepStrictEqual(inv.output['interval_analysis'], overviewImaging.interval_analysis) &&
                isDeepStrictEqual(inv.output['hcq_progression'], overviewImaging.hcq_progression);
            const goldens =
                inv.output['scan_count'] === scans &&
                inv.output['first_capture_date'] === first &&
                inv.output['latest_capture_date'] === latest;
            return { name, cohesive, goldens, scans: inv.output['scan_count'] };
        });

        const pass = verdicts.every((v) => v.cohesive && v.goldens);
        recordEval({
            id: 'imaging-cohesion.one-source-of-truth',
            description:
                "get_imaging_overview returns byte-identical timeline / interval analysis / HCQ progression to buildOverview's imaging block (what the panel's analytics rail renders), for both corpora",
            metric: 'tool output ≡ overview imaging block (deep-equal, both corpora) + scan-count goldens',
            value: verdicts.map((v) => `${v.name}: cohesive=${v.cohesive}, ${String(v.scans)} scans golden=${v.goldens}`).join('; '),
            threshold: 'deep-equal on all three derived structures; margaret 6 scans, william 7',
            pass,
            difficulty: 'straightforward',
        });
    });

    it('the overview tool rides the real chat loop: verbatim tool_result, then a grounded final', async () => {
        const bundle = seededFactBundle(margaretChen);
        const direct = getImagingOverview.invoke(bundle, {});

        const finalReply = 'Six OCTs from Dec 2021 to Dec 2024; GC-IPL thinning is the flagged trend.';
        const { client, requests } = scriptedClient([
            llmToolUseResponse([{ id: 'tu-ov', name: 'get_imaging_overview', input: {} }], 'Checking the imaging story.'),
            llmResponse(finalReply),
        ]);
        const service = new ChatService(client, new MemoryChatStore());

        const result = await service.turn(
            { bundle, conversationId: 'conv-ic-1', message: 'How have her scans been trending?', correlationId: 'eval-ic-1' },
            silentLogger,
        );

        const followUp = requests[1] ?? {};
        const messages = (followUp['messages'] ?? []) as { role: string; content: unknown }[];
        const lastBlocks = (messages.at(-1)?.content ?? []) as Record<string, unknown>[];
        const toolResult = lastBlocks.find((block) => block['type'] === 'tool_result');
        // Compare in serialized form: treatment_context.last_treatment.dose is an optional
        // key the corpus leaves undefined, and JSON (the wire format the model reads)
        // drops undefined-valued keys.
        const fedBackVerbatim =
            toolResult !== undefined &&
            toolResult['tool_use_id'] === 'tu-ov' &&
            toolResult['is_error'] === undefined &&
            isDeepStrictEqual(JSON.parse(String(toolResult['content'])), JSON.parse(JSON.stringify(direct.output)));

        const pass =
            direct.ok &&
            fedBackVerbatim &&
            isDeepStrictEqual(result.tools_used, ['get_imaging_overview']) &&
            result.reply.includes(finalReply);

        recordEval({
            id: 'imaging-cohesion.tool-loop-round-trip',
            description:
                "A trend question answered through the real loop: get_imaging_overview executes over Margaret's record and its output rides the tool_result byte-identical to a direct invocation",
            metric: 'tool executed in-loop / tool_result verbatim / final reply lands',
            value: `tools_used=${result.tools_used.join(',') || 'none'}; verbatim=${fedBackVerbatim}; reply delivered=${result.reply.includes(finalReply)}`,
            threshold: 'get_imaging_overview runs once; tool_result deep-equals direct output; reply delivered',
            pass,
            difficulty: 'straightforward',
        });
    });

    it('describe_scan attaches real pixels through the loop and the observation stays quarantined', async () => {
        const bundle = seededFactBundle(margaretChen);
        const withPixels = bundle.images.find((image) => typeof image['storage_key'] === 'string');
        const imageId = withPixels?.id ?? 'img-mc-006';

        const observation =
            'AI visual observation (not from the record): central dome-shaped elevation consistent with the authored reading.';
        const { client, requests } = scriptedClient([
            llmToolUseResponse([{ id: 'tu-look', name: 'describe_scan', input: { image_id: imageId } }]),
            llmResponse(observation),
        ]);
        const loads: string[] = [];
        const service = new ChatService(client, new MemoryChatStore(), undefined, undefined, (storageKey) => {
            loads.push(storageKey);
            return Promise.resolve({ mediaType: 'image/jpeg', base64: 'UElYRUxT' });
        });

        const result = await service.turn(
            { bundle, conversationId: 'conv-ic-4', message: 'What does the latest scan actually look like?', correlationId: 'eval-ic-4' },
            silentLogger,
        );

        // The wire: request 2's tool_result carries [verbatim JSON text, base64 image block].
        const followUp = requests[1] ?? {};
        const messages = (followUp['messages'] ?? []) as { role: string; content: unknown }[];
        const toolResult = ((messages.at(-1)?.content ?? []) as Record<string, unknown>[]).find(
            (block) => block['type'] === 'tool_result',
        );
        const content = (toolResult?.['content'] ?? []) as Record<string, unknown>[];
        const textBlock = content[0] as { text?: string } | undefined;
        const imageBlock = content[1] as { type?: string; source?: { data?: string } } | undefined;
        const pixelsAttached =
            Array.isArray(content) &&
            content.length === 2 &&
            typeof textBlock?.text === 'string' &&
            textBlock.text.includes('"attach_image":true') &&
            imageBlock?.type === 'image' &&
            imageBlock.source?.data === 'UElYRUxT';

        // The quarantine: prompt pins present; the reply keeps the mandatory prefix; the
        // visual read produced zero citations (never provenance).
        const system = String((requests[0] ?? {})['system'] ?? '');
        const quarantinePinned =
            system.includes('"AI visual observation (not from the record):"') &&
            system.includes('never cite it') &&
            system.includes('defer to the record');
        const pass =
            loads.length === 1 &&
            pixelsAttached &&
            quarantinePinned &&
            isDeepStrictEqual(result.tools_used, ['describe_scan']) &&
            result.reply.includes('AI visual observation (not from the record):') &&
            result.citations.length === 0;

        recordEval({
            id: 'imaging-cohesion.describe-scan-media-loop',
            description:
                "describe_scan over Margaret's record: the loop loads the scan's stored pixels and attaches them to the tool_result as an image block, the prompt quarantines the visual read, and the observation arrives prefixed and uncited",
            metric: 'pixels attached / quarantine pinned / observation prefixed + uncited',
            value: `loader calls=${String(loads.length)}; pixels attached=${String(pixelsAttached)}; quarantine pinned=${String(quarantinePinned)}; tools_used=${result.tools_used.join(',')}; citations=${String(result.citations.length)}`,
            threshold: 'one pixel load; tool_result = [json text, image block]; all quarantine pins present; prefixed reply with 0 citations',
            pass,
            difficulty: 'straightforward',
        });
    });

    // Behavioral, opt-in: replays the observed IC0 failure (chat claimed no access to OCT
    // trends while the rail displayed them). Run with LIVE_EVALS=1 — spends real tokens.
    const LIVE = process.env['LIVE_EVALS'] === '1' && (process.env['ANTHROPIC_API_KEY'] ?? '') !== '';
    const IMAGING_TOOLS = ['get_imaging_overview', 'get_measurement_trend', 'compare_scans'];
    it.skipIf(!LIVE)('live: a trend ask consults an imaging tool instead of claiming absence', async () => {
        const bundle = seededFactBundle(margaretChen);
        const service = new ChatService(
            new AnthropicClient({
                apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
                model: process.env['LLM_MODEL'] ?? 'claude-haiku-4-5',
            }),
            new MemoryChatStore(),
        );

        const result = await service.turn(
            {
                bundle,
                conversationId: 'conv-ic-live',
                message: 'How have her OCT scans been trending? Any progression I should know about?',
                correlationId: 'eval-ic-live',
            },
            silentLogger,
        );

        const usedImagingTool = result.tools_used.some((name) => IMAGING_TOOLS.includes(name));
        const claimsAbsence = /\b(don'?t|do not|no) (have )?(access|prior|imaging|trend|oct)|not in the record/i.test(result.reply);

        recordEval({
            id: 'imaging-cohesion.live-absence-guard',
            description:
                "LIVE (opt-in): asked the exact question that previously drew a false 'no access to prior OCT trends' claim, the real model consults an imaging tool and answers from it",
            metric: 'imaging tool invoked / no absence claim in the reply',
            value: `tools_used=${result.tools_used.join(',') || 'none'}; imaging tool used=${usedImagingTool}; absence claim=${claimsAbsence}`,
            threshold: 'at least one of get_imaging_overview/get_measurement_trend/compare_scans runs; reply makes no absence claim',
            pass: usedImagingTool && !claimsAbsence && result.reply.trim().length > 0,
            // Live tool-choice judgment: replays an observed real-model failure (false absence claim).
            difficulty: 'ambiguous',
            notes: 'Behavioral case, runs only with LIVE_EVALS=1 + ANTHROPIC_API_KEY; spends real tokens. The committed report reflects the deterministic run unless a live run regenerated it.',
        });
    });
});
