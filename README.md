[![Syntax Status](https://github.com/openemr/openemr/actions/workflows/syntax.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/syntax.yml)
[![Styling Status](https://github.com/openemr/openemr/actions/workflows/styling.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/styling.yml)
[![Testing Status](https://github.com/openemr/openemr/actions/workflows/test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/test.yml)
[![JS Unit Testing Status](https://github.com/openemr/openemr/actions/workflows/js-test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/js-test.yml)
[![PHPStan](https://github.com/openemr/openemr/actions/workflows/phpstan.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/phpstan.yml)
[![Rector](https://github.com/openemr/openemr/actions/workflows/rector.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/rector.yml)
[![ShellCheck](https://github.com/openemr/openemr/actions/workflows/shellcheck.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/shellcheck.yml)
[![Docker Compose Linting](https://github.com/openemr/openemr/actions/workflows/docker-compose-lint.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/docker-compose-lint.yml)
[![Dockerfile Linting](https://github.com/openemr/openemr/actions/workflows/docker-lint-hadolint.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/docker-lint-hadolint.yml)
[![Isolated Tests](https://github.com/openemr/openemr/actions/workflows/isolated-tests.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/isolated-tests.yml)
[![Inferno Certification Test](https://github.com/openemr/openemr/actions/workflows/inferno-test.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/inferno-test.yml)
[![Composer Checks](https://github.com/openemr/openemr/actions/workflows/composer.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/composer.yml)
[![Composer Require Checker](https://github.com/openemr/openemr/actions/workflows/composer-require-checker.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/composer-require-checker.yml)
[![API Docs Freshness Checks](https://github.com/openemr/openemr/actions/workflows/api-docs.yml/badge.svg)](https://github.com/openemr/openemr/actions/workflows/api-docs.yml)
[![codecov](https://codecov.io/gh/openemr/openemr/graph/badge.svg?token=7Eu3U1Ozdq)](https://codecov.io/gh/openemr/openemr)

[![Backers on Open Collective](https://opencollective.com/openemr/backers/badge.svg)](#backers) [![Sponsors on Open Collective](https://opencollective.com/openemr/sponsors/badge.svg)](#sponsors)

# AgentForge Clinical Co-Pilot (OpenEMR fork)

This is a fork of [OpenEMR](https://github.com/openemr/openemr) used for the
AgentForge Clinical Co-Pilot project: an AI co-pilot for **Dan, a retina
surgeon**, embedded beside a brownfield EHR. **All patient data anywhere in
this project is synthetic.**

> **Evaluating this project? Start at [`EVALUATION.html`](EVALUATION.html)** —
> the one-page guide to every live surface, graded document, and runnable check.
> For Week 2 specifically, the front door is [`W2_ARCHITECTURE.md`](W2_ARCHITECTURE.md).

## Deployed

- **Live EHR:** https://gw1-openemr-base-clean-production.up.railway.app
  (demo instance, synthetic data only)
- **Live agent (sidecar API + panel):** https://enchanting-mercy-production-5d32.up.railway.app
  (auth enforced: the panel signs in via the dev-login role switcher; API calls
  need a patient-bound bearer — see `docs/RUNBOOK.md` §D)
- **Branches:** `main` is stable/instructor-facing and drives the deploys;
  active development lands on `claude/openemr-rag-requirements-x25vzm` → PR #9
  → `main` (see [`RELEASE.md`](RELEASE.md)).

## Week 1 baseline vs Week 2 additions

Week 1 behavior is **unchanged**: the brief-first prep pipeline, sub-2s chat
over prepared facts, the deterministic citation gate, and the imaging tools
all run exactly as audited. Week 2 adds the multimodal evidence agent beside
them:

| Week 1 baseline (unchanged) | Week 2 additions (this project) |
|---|---|
| Pre-visit brief + 8 read-only chat tools over prepared facts | `attach_and_extract` document ingestion (lab PDF + intake form) with strict schemas |
| Deterministic citation gate (verbatim verification, withhold-at-server) | Geometric grounding + panel **PDF bbox overlay** (three visibly distinct outcomes; unverified is never citable) |
| Whole-patient context (no vector search for patient facts) | Hybrid RAG over an authored practice-protocol corpus (BM25 + dense → RRF → rerank) with an out-of-domain refusal floor |
| Single tool-loop chat agent | Supervisor/worker LangGraph with the gate promoted to critic; evidence turns stream in chat behind a router |
| 24-case eval harness | **58-case, six-category, PR-blocking eval gate** — rehearsed against injected regressions (`npm run gate-rehearsal`) |
| Dev-login role model (read scopes) | Write-path auth: uploads demand an attributable role in every mode |

## Quickstart (no guessing)

**OpenEMR** (optional — sidecar-only grading works against the deployed EHR):

```bash
cd docker/development-easy && docker compose up --detach --wait
# http://localhost:8300 — login admin / pass
```

**Sidecar** (Node 22 + Postgres):

```bash
cd sidecar && npm ci
DATABASE_URL=postgres://user:pass@localhost:5432/copilot npm run dev   # boots + migrates
npx tsx src/scripts/seed.ts    # seed the five synthetic patients
npm test && npm run eval       # keyless by design — the full gate runs with zero API keys
```

A keyless boot works: features degrade per the env table below (evidence
turns fall back to the Week 1 loop, retrieval runs offline backends) and
`/ready` names every degradation.

**Panel:**

```bash
cd sidecar/panel && npm ci && npm run build    # or: npm run dev (Vite proxy → :8080)
```

## Environment variables

Every key `sidecar/src/config.ts` reads. Boot-resilience property: an invalid
value never crashes boot — the feature disables with a `[config]` warning.

| Variable | Default | What it unlocks (and what absence degrades to) |
|---|---|---|
| `PORT` | `8080` | listen port |
| `NODE_ENV` | `development` | `production` makes openemr/anthropic required in `/ready` |
| `DATABASE_URL` | — | fact store: prep, chat, verify, facts, ledger (absent → 503 `store_not_configured`) |
| `ANTHROPIC_API_KEY` | — | prep extraction, chat turns, VLM ingestion, router tie-break, evidence composer (absent → evidence turns fall back to the Week 1 loop; boot log says so) |
| `ANTHROPIC_MODEL_PREP` / `ANTHROPIC_MODEL_CHAT` | `claude-haiku-4-5` | model pins |
| `LLM_DAILY_BUDGET_USD` | `5` | SpendGuard cap (**do not raise** — a deliberate go-live decision) |
| `LLM_MAX_OUTPUT_TOKENS` / `LLM_CHAT_MAX_OUTPUT_TOKENS` | `8192` / `1024` | per-call output ceilings |
| `LLM_INPUT_USD_PER_MTOK` / `LLM_OUTPUT_USD_PER_MTOK` | `1` / `5` | ledger pricing rates |
| `LLM_MAX_CONCURRENT_PREPS` / `PREP_REUSE_WINDOW_MINUTES` | `2` / `10` | prep throttles |
| `OPENEMR_BASE_URL` | — | EHR probes + FHIR sync + document storage base |
| `OPENEMR_CLIENT_ID` / `OPENEMR_CLIENT_KEY` | — | FHIR read client (EHR sync) |
| `OPENEMR_API_USERNAME` / `OPENEMR_API_PASSWORD` | — | password-grant document writes into OpenEMR Documents (absent → sidecar-side storage only, stated in the ingestion record) |
| `OPENEMR_OAUTH_SITE` | `default` | OAuth site path segment |
| `AUTH_MODE` | `off` | `enforced` turns on the global PEP (401/403); upload + verify writes require a bearer **in every mode** |
| `DEV_LOGIN_SECRET` (≥16 chars) / `DEV_TOKEN_TTL_SECONDS` | — / `3600` | `POST /api/dev-login` demo tokens (required for uploads) |
| `COHERE_API_KEY` | — | live dense embeddings + rerank (absent → offline hash-embed + passthrough rerank; `/ready` shows `reranker: not_configured`) |
| `COHERE_EMBED_MODEL` / `COHERE_RERANK_MODEL` | `embed-english-v3.0` / `rerank-english-v3.0` | Cohere model pins |
| `RETRIEVER_DENSE_BACKEND` | `pgvector` | `memory` = in-process cosine fallback (`npm run verify:pgvector` decides which) |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | prep + graph-span tracing (all three or nothing) |
| `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` | `false` / — / `clinical-copilot-w2-demo` | **demo env only** (locked decision #2; boot log states the posture) |
| `SCAN_IMAGES_DIR` | baked seed | scan pixels dir for `/api/images` |
| `REDIS_URL` | — | reserved (unused; queue is documented Week 1 debt) |

Key-drop steps with verification: [`docs/w2/tickets/USER-ACTIONS.md`](docs/w2/tickets/USER-ACTIONS.md).

## Deliverables & doc map

**Week 2 (D1–D8):**

| # | Deliverable | Location |
|---|---|---|
| D1 | Repo + setup (this README) + deployed links | you are here |
| D2 | Week 2 architecture | [`W2_ARCHITECTURE.md`](W2_ARCHITECTURE.md) |
| D3 | Extraction schemas + validation tests | [`sidecar/src/schemas/extraction.ts`](sidecar/src/schemas/extraction.ts), [`sidecar/test/extraction-schemas.test.ts`](sidecar/test/extraction-schemas.test.ts) |
| D4 | Eval dataset (58 cases, six categories, baselined) | [`sidecar/eval/`](sidecar/eval/), [`docs/execution/eval-results.md`](docs/execution/eval-results.md) |
| D5 | CI gate evidence + injected-regression rehearsal | [`docs/w2/gate-rehearsal.md`](docs/w2/gate-rehearsal.md), [`.github/workflows/evals.yml`](.github/workflows/evals.yml), [`.githooks/pre-push`](.githooks/pre-push) |
| D6 | Demo video | script: [`docs/w2/demo-script.md`](docs/w2/demo-script.md) — *recording pending (link lands here)* |
| D7 | Cost & latency report | [`docs/COSTS.md`](docs/COSTS.md) §6, [`docs/execution/baselines.md`](docs/execution/baselines.md) |
| D8 | Deployed app | URLs above |

**Week 2 working docs:** [build-status dashboard](docs/w2/build-status.html) ·
[requirements register](docs/w2/requirements.md) ·
[execution plan](docs/w2/execution-plan.md) ·
[ticket specs (cold-executable)](docs/w2/tickets/) ·
[trace worked example](docs/w2/trace-example.md) ·
[defense outline](docs/w2/defense-outline.md) ·
[OpenAPI contract](sidecar/openapi.yaml) ·
[Bruno collection](sidecar/api-collection/)

**Week 1 baseline docs:** [`AUDIT.md`](AUDIT.md) · [`USERS.md`](USERS.md) ·
[`ARCHITECTURE.md`](ARCHITECTURE.md) · [`docs/VERIFICATION.md`](docs/VERIFICATION.md) ·
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) (activation + backup §E) ·
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) ·
[ops dashboard](docs/execution/ops-status.html) ·
[observability & alerts](docs/execution/observability.md) ·
[defense](docs/defense/architecture-defense.md) · [PRD](docs/defense/PRD-clinical-copilot.md) ·
[Railway runbook](deploy/railway-runbook.md)

The original OpenEMR README follows.

# OpenEMR

[OpenEMR](https://open-emr.org) is a Free and Open Source electronic health records and medical practice management application. It features fully integrated electronic health records, practice management, scheduling, electronic billing, internationalization, free support, a vibrant community, and a whole lot more. It runs on Windows, Linux, Mac OS X, and many other platforms.

### Contributing

OpenEMR is a leader in healthcare open source software and comprises a large and diverse community of software developers, medical providers and educators with a very healthy mix of both volunteers and professionals. [Join us and learn how to start contributing today!](https://open-emr.org/wiki/index.php/FAQ#How_do_I_begin_to_volunteer_for_the_OpenEMR_project.3F)

> Already comfortable with git? Check out [CONTRIBUTING.md](CONTRIBUTING.md) for quick setup instructions and requirements for contributing to OpenEMR by resolving a bug or adding an awesome feature 😊.

### Support

Community and Professional support can be found [here](https://open-emr.org/wiki/index.php/OpenEMR_Support_Guide).

Extensive documentation and forums can be found on the [OpenEMR website](https://open-emr.org) that can help you to become more familiar about the project 📖.

### Reporting Issues and Bugs

Report these on the [Issue Tracker](https://github.com/openemr/openemr/issues). If you are unsure if it is an issue/bug, then always feel free to use the [Forum](https://community.open-emr.org/) and [Chat](https://www.open-emr.org/chat/) to discuss about the issue 🪲.

### Reporting Security Vulnerabilities

Check out [SECURITY.md](.github/SECURITY.md)

### API

Check out [API_README.md](API_README.md)

### Docker

Check out [DOCKER_README.md](DOCKER_README.md)

### FHIR

Check out [FHIR_README.md](FHIR_README.md)

### For Developers

If using OpenEMR directly from the code repository, then the following commands will build OpenEMR (Node.js version 24.* is required) :

```shell
composer install --no-dev
npm install
npm run build
composer dump-autoload -o
```

### Contributors

This project exists thanks to all the people who have contributed. [[Contribute]](CONTRIBUTING.md).
<a href="https://github.com/openemr/openemr/graphs/contributors"><img src="https://opencollective.com/openemr/contributors.svg?width=890" /></a>


### Sponsors

Thanks to our [ONC Certification Major Sponsors](https://www.open-emr.org/wiki/index.php/OpenEMR_Certification_Stage_III_Meaningful_Use#Major_sponsors)!


### License

[GNU GPL](LICENSE)
