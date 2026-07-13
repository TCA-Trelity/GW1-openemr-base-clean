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
AgentForge Clinical Co-Pilot project: an AI co-pilot for ophthalmology
embedded in a brownfield EHR.

> **Evaluating this project? Start at [`EVALUATION.html`](EVALUATION.html)** —
> the one-page guide to every live surface, graded document, and runnable check.

- **Live EHR:** https://gw1-openemr-base-clean-production.up.railway.app
  (demo instance, synthetic data only)
- **Live agent (sidecar API + panel):** https://enchanting-mercy-production-5d32.up.railway.app
  (auth enforced: the panel signs in via the dev-login role switcher; API calls
  need a patient-bound bearer — see `docs/RUNBOOK.md` §D)
- **Branches:** `main` is stable/instructor-facing and drives the deploys;
  active development lands on the working branch (see [`RELEASE.md`](RELEASE.md))

| Deliverable | Location |
|---|---|
| **Evaluation guide (graders start here)** | [`EVALUATION.html`](EVALUATION.html) |
| Security & architecture audit | [`AUDIT.md`](AUDIT.md) |
| Users & use cases | [`USERS.md`](USERS.md) |
| Agent integration architecture | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Verification path (response → user, traced) | [`docs/VERIFICATION.md`](docs/VERIFICATION.md) |
| Early-submission readiness trace | [`docs/defense/early-submission-readiness.md`](docs/defense/early-submission-readiness.md) |
| Activation runbook (EHR link, Langfuse, auth) | [`docs/RUNBOOK.md`](docs/RUNBOOK.md) |
| Operations & production readiness | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) |
| **Operational review dashboard** (load, evals, alerts, cost — one page) | [`docs/execution/ops-status.html`](docs/execution/ops-status.html) |
| Dashboard tiles & alerts spec | [`docs/execution/observability.md`](docs/execution/observability.md) |
| Performance baselines (load tests) | [`docs/execution/baselines.md`](docs/execution/baselines.md) |
| Eval suite & results | [`sidecar/eval/`](sidecar/eval/), [`docs/execution/eval-results.md`](docs/execution/eval-results.md) |
| AI cost analysis | [`docs/COSTS.md`](docs/COSTS.md) |
| Runnable API collection (Bruno) | [`sidecar/api-collection/`](sidecar/api-collection/) |
| Architecture defense (full) | [`docs/defense/architecture-defense.md`](docs/defense/architecture-defense.md) |
| Pre-search checklist (appendix Q1–16) | [`docs/defense/presearch.md`](docs/defense/presearch.md) |
| Tiered PRD | [`docs/defense/PRD-clinical-copilot.md`](docs/defense/PRD-clinical-copilot.md) |
| Railway deploy runbook | [`deploy/railway-runbook.md`](deploy/railway-runbook.md) |

### Week 2 — Multimodal Evidence Agent (in progress)

Week 2 adds document ingestion (lab PDF + intake form), hybrid RAG over a
practice-guideline corpus, a supervisor/worker graph, and a PR-blocking eval
gate. Week 1 baseline behavior above is unchanged until Week 2 waves land.

| Week 2 deliverable | Location |
|---|---|
| **Build status dashboard (tickets, requirements, analytics)** | [`docs/w2/build-status.html`](docs/w2/build-status.html) |
| **Week 2 architecture (start here for W2)** | [`W2_ARCHITECTURE.md`](W2_ARCHITECTURE.md) |
| Requirements register (canonical, anti-drift) | [`docs/w2/requirements.md`](docs/w2/requirements.md) |
| Execution plan (waves, tickets) | [`docs/w2/execution-plan.md`](docs/w2/execution-plan.md) |
| Architecture-defense outline (6 slides) | [`docs/w2/defense-outline.md`](docs/w2/defense-outline.md) |

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
