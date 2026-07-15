# Worked example: reconstructing a multi-agent trace from one correlation ID

**Requirement:** C.5 (REQ G4/G13, pitfall P3) — *one correlation ID reconstructs the
full multi-agent trace.* The graph logs a structured `worker_handoff` event on every
transition, tagged with the correlation ID, the two node names, and the routing reason.
Nothing below is illustrative prose: these are verbatim log lines emitted by
`runClinicalGraph` (offline backends, stubbed VLM over the committed
`renal-panel-clean.pdf` fixture) — the same code path production runs.

## The query

```
grep '"correlation_id":"w2-demo-7f3a"' <log stream>
```

Every line of the multi-agent run comes back, in order. That is the whole recipe.

## Run 1 — document upload (Tier 2, prep-time graph), `w2-demo-7f3a`

Margaret Chen's renal panel PDF arrives. The supervisor routes it to the
intake-extractor; extraction findings drive an evidence retrieval whose chunks are
pinned; the critic verifies the drafted claim before release.

```json
{"level":"info","msg":"worker_handoff","correlation_id":"w2-demo-7f3a","patient_id":"margaret-chen","from":"supervisor","to":"intake_extractor","routing_reason":"document upload event (rule)"}
{"level":"info","msg":"worker_handoff","correlation_id":"w2-demo-7f3a","patient_id":"margaret-chen","from":"intake_extractor","to":"evidence_retriever","routing_reason":"extraction complete; pin protocol evidence for extracted findings"}
{"level":"info","msg":"evidence_pinned","correlation_id":"w2-demo-7f3a","patient_id":"margaret-chen","ingestion_id":"ing-fbc0385ca41a","pinned":4}
{"level":"info","msg":"worker_handoff","correlation_id":"w2-demo-7f3a","patient_id":"margaret-chen","from":"evidence_retriever","to":"critic","routing_reason":"4 chunk(s), rerank_applied=false"}
{"level":"info","msg":"worker_handoff","correlation_id":"w2-demo-7f3a","patient_id":"margaret-chen","from":"critic","to":"answer","routing_reason":"1 verified / 0 blocked claim(s); 0 lint flag(s)"}
```

Reconstructed trace (parent/child by from→to order — the span tree the tracer binding
in E.4 + H.7 renders in Langfuse: workers ⊂ supervisor, sub-calls ⊂ their worker):

```
clinical_graph w2-demo-7f3a  (patient margaret-chen)
└─ supervisor                    routed: document upload event (rule)
   ├─ intake_extractor           extraction complete → ingestion ing-fbc0385ca41a
   ├─ evidence_retriever         4 chunks against margaret-chen (Tier-0 for the visit)
   │  └─ evidence_pinned         ingestion ing-fbc0385ca41a, pinned 4
   ├─ critic                     1 verified / 0 blocked; 0 prescriptiveness flags
   └─ answer                     released with guideline citations only
```

Note what the events already answer without any tracing backend:

- **Why did this run extract?** `routing_reason: "document upload event (rule)"` — a
  deterministic rule, not a model guess (`(rule)` vs `(model)` is logged on every
  decision).
- **Where did the pinned evidence come from?** `evidence_pinned` carries the
  `ingestion_id`, which keys back to the ingestion record, its OpenEMR document, and
  the sha3-512 of the original bytes.
- **Did anything get blocked?** The critic's handoff states verified/blocked counts;
  a blocked claim additionally emits a `critic_flags` warn event under the same
  correlation ID.

## Run 2 — guideline chat turn (Tier 1), `w2-demo-9c1e`

Same patient, in-visit ask: *"What screening interval do the guidelines recommend for
hydroxychloroquine with reduced renal function?"*

```json
{"level":"info","msg":"worker_handoff","correlation_id":"w2-demo-9c1e","patient_id":"margaret-chen","from":"supervisor","to":"evidence_retriever","routing_reason":"asks for guideline/protocol (rule)"}
{"level":"info","msg":"worker_handoff","correlation_id":"w2-demo-9c1e","patient_id":"margaret-chen","from":"evidence_retriever","to":"critic","routing_reason":"4 chunk(s), rerank_applied=false"}
{"level":"info","msg":"worker_handoff","correlation_id":"w2-demo-9c1e","patient_id":"margaret-chen","from":"critic","to":"answer","routing_reason":"1 verified / 0 blocked claim(s); 0 lint flag(s)"}
```

Outcome (from the same run): `route=needs_evidence`, 1 verified / 0 blocked claims,
citation `renal-function-ocular-drug-safety#purpose-and-scope` — a `guideline_evidence`
citation whose quote the critic verified verbatim against the stored chunk.

## Degraded and blocked paths carry the same ID

Two failure-mode events ride the identical correlation key (asserted in
`sidecar/test/graph.test.ts`):

- `evidence_degraded` (warn) — retrieval exceeded the Tier-1 budget; the handoff reason
  becomes `degraded: retrieval exceeded <n>ms budget — answering without evidence`.
- `critic_flags` (warn) — the citation gate blocked claims and/or the prescriptiveness
  lint flagged the draft; blocked claims never release citations.

## Where this went (E.4 + H.7)

These events are the span skeleton, and the Langfuse binding
(`sidecar/src/obs/graphTracer.ts`, E.4) consumes exactly this event stream — no new
instrumentation points were added to the graph. H.7 shipped the nesting: one
`supervisor` span per trace (trace id = the correlation id), each worker
(`intake_extractor`, `evidence_retriever`, `critic`, `answer`) a child span of
`supervisor`, and sub-call events children of their worker span —
`evidence_pinned` / `evidence_degraded` under `evidence_retriever`, `critic_flags`
under `critic`, ingestion stage events under `intake_extractor` (G13). A handoff
FROM a worker ends that worker's span. The tree shape is pinned by span-parent
assertions in `sidecar/test/obs.test.ts`; the visual confirm of a live Langfuse
trace stays USER-ACTIONS item 10.

PHI note (G5): events carry IDs (`patient_id`, `ingestion_id`, chunk ids) and counts —
never document text, extracted values, or names from documents. The log-capture PHI
sweep (D.5) asserts this over captured runs.
