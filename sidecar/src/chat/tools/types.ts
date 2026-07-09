// Chat tool contracts (TC1). Each tool is a PURE, read-only function over the current
// patient's FactBundle — patient-scoping is inherent because a tool only ever sees THIS
// bundle. Zod schemas for input AND output are the source of truth (engineering
// requirement): input is parsed at the model boundary, output is validated before it is
// serialized into a tool_result block. A tool NEVER throws; unresolvable input degrades to
// a structured { error } result the model can read and recover from (graceful degradation).
import { z } from 'zod';
import type { FactBundle } from '../../store/index.js';

/**
 * Document-quoting provenance a tool result carries so the server-side citation gate can
 * verify the excerpt verbatim against OUR stored copy and attach it as a citation. Computed
 * (derived) tools carry none — their output is labeled derived, never quoted as source text.
 */
export interface ToolProvenance {
    source_document_id: string;
    excerpt: string;
}

/** The result of invoking a tool: ok, the structured output, and any document provenance. */
export interface ToolInvocation {
    /** false when the tool returned a structured { error } (bad or unresolvable input). */
    ok: boolean;
    /** Structured result serialized into the tool_result content block. */
    output: Record<string, unknown>;
    /** Document-quoting provenance for citation verification (empty for derived tools). */
    provenance: ToolProvenance[];
}

/** The uniform, type-erased tool surface the ChatService tool-use loop drives by name. */
export interface RegisteredTool {
    readonly name: string;
    readonly description: string;
    /** JSON Schema object sent as the Anthropic tool `input_schema`. */
    readonly inputJsonSchema: Record<string, unknown>;
    /** Parse model-provided input, execute over THIS bundle, and never throw. */
    invoke(bundle: FactBundle, rawInput: unknown): ToolInvocation;
}

/** The error shape every tool shares — a structured result, never an exception. */
export const ToolErrorSchema = z.object({ error: z.string().min(1) });
export type ToolError = z.infer<typeof ToolErrorSchema>;

/** Per-tool specification carrying its typed schemas and its pure execution function. */
export interface ToolSpec<TInput, TOutput extends object> {
    name: string;
    description: string;
    // Input generic left as `unknown` so schemas carrying Zod defaults (whose parsed input
    // type differs from their output type) remain assignable.
    inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
    outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
    /** JSON Schema mirror of inputSchema for the Anthropic tools array. */
    inputJsonSchema: Record<string, unknown>;
    /** Pure, read-only execution over the bundle. Returns the success shape or { error }. */
    run(bundle: FactBundle, input: TInput): TOutput;
    /** Document-quoting provenance for a successful output (omit for derived tools). */
    provenance?(output: TOutput): ToolProvenance[];
}

/**
 * Wrap a typed ToolSpec into a uniform RegisteredTool. Input is parsed at the boundary
 * (invalid -> structured error); output is validated against its contract before use.
 */
export function defineTool<TInput, TOutput extends object>(spec: ToolSpec<TInput, TOutput>): RegisteredTool {
    return {
        name: spec.name,
        description: spec.description,
        inputJsonSchema: spec.inputJsonSchema,
        invoke(bundle: FactBundle, rawInput: unknown): ToolInvocation {
            const parsedInput = spec.inputSchema.safeParse(rawInput ?? {});
            if (!parsedInput.success) {
                return { ok: false, output: { error: `invalid input for ${spec.name}` }, provenance: [] };
            }
            const produced = spec.run(bundle, parsedInput.data);
            const parsedOutput = spec.outputSchema.safeParse(produced);
            const output: TOutput = parsedOutput.success ? parsedOutput.data : produced;
            const ok = !('error' in output);
            const provenance = ok && spec.provenance !== undefined ? spec.provenance(output) : [];
            return { ok, output: output as Record<string, unknown>, provenance };
        },
    };
}

/** Small shared guard: a plain (non-array) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
