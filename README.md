# Webhook Automation Runner

A self-hostable tool that runs small automations — triggered by a webhook or a
schedule — with a visual editor and a run history that tells you exactly what
happened.

## Status: Phase 2 — REST API and persistence

Phase 1 (engine + schema) is done and untouched by Phase 2. Phase 2 wires
the engine to a real Postgres database (Neon) behind a REST API: workflows
are persisted, triggering a workflow enqueues a `run`, and a background job
loop claims and executes pending runs, recording a complete per-node result.

```
src/
  db/
    schema.ts        Drizzle schema: workflows, nodes, edges, runs, node_executions
    client.ts         Postgres connection (drizzle-orm/postgres-js), reads DATABASE_URL
    repository.ts      All queries: create/list/get workflows, enqueue/claim/record runs
  engine/              Unchanged from Phase 1 — see below
  api/
    app.ts             Express app: JSON body parsing, routes, error handler
    server.ts           Entrypoint: starts the HTTP server and the job loop
    routes/
      workflows.ts       POST/GET /workflows, POST /workflows/:id/trigger, GET .../runs
      runs.ts             GET /runs/:id
      webhooks.ts         POST /webhooks/:workflowId
  jobs/
    processor.ts        claimNextPendingRun + executeWorkflow + persist, on a poll loop
tests/
  plan.test.ts / engine.test.ts / executors.test.ts   (Phase 1, DB-free)
```

### Running the tests

```
npm install
npm test        # 42 Vitest tests, no database required
npm run typecheck
```

### Running the API

```
npm run db:push   # apply src/db/schema.ts to DATABASE_URL (see .env.example)
npm run dev        # starts the REST API + job loop on $PORT (default 4000)
```

### The REST API

| | |
|---|---|
| `POST /workflows` | Create a workflow: `{ name, description?, nodes: [{ id, type, name, config }], edges: [{ id, source, target, branch? }] }`. Node/edge ids are caller-supplied strings, unique per workflow — there's no editor yet to generate them. |
| `GET /workflows` | List workflows. |
| `GET /workflows/:id` | A workflow with its nodes and edges. |
| `POST /workflows/:id/trigger` | Manual "Run now" — body becomes the trigger payload. Enqueues a `run`, returns `202`. |
| `GET /workflows/:id/runs` | Runs for a workflow, newest first. |
| `GET /runs/:id` | A run with all of its `node_executions` — input, output, error, duration per node. |
| `POST /webhooks/:workflowId` | The webhook trigger. Same enqueue path as manual trigger, `triggerType: "webhook"`. |

### How a run actually executes

`POST /webhooks/:id` (or `.../trigger`) only inserts a `runs` row with
`status: "pending"` — it does not run anything inline. A separate poll loop
(`jobs/processor.ts`) claims pending runs and executes them:

```sql
SELECT ... FROM runs WHERE status = 'pending' ORDER BY created_at
FOR UPDATE SKIP LOCKED LIMIT 1
```

`FOR UPDATE` locks the row for the claiming transaction; `SKIP LOCKED` means
a second poller (a second server instance, or the same one on its next tick)
skips straight past a row another transaction already has locked, instead of
blocking on it — so two workers can never claim, and therefore execute, the
same run. The claim and the `status: "running"` update happen in the same
transaction as the read.

Once claimed, the run's workflow graph is loaded from Postgres, converted to
the shape the pure Phase 1 engine expects (`toWorkflowDefinition`), executed
in-process, and the full `RunResult` — including every `skipped` node — is
persisted to `node_executions` in one transaction alongside the run's final
status.

### How the engine works

`buildExecutionPlan` topologically sorts a workflow's nodes into a static
execution order and rejects cycles. `executeWorkflow` walks that order and,
for each node, decides whether it's *eligible* to run: root nodes always are;
any other node needs at least one incoming edge whose source node succeeded
(and, for edges out of a `condition` node, whose branch — `true`/`false` —
matches that node's boolean output). Ineligible nodes are recorded as
`skipped` rather than executed, so a condition's untaken branch never runs
and a node downstream of a failure doesn't either — while an independent
branch that never depended on the failure still does.

Per node, the engine supports:
- **Retries** (`node.retry.maxAttempts` / `backoffMs`) — re-invokes the
  executor on failure, with an injectable `sleep` between attempts so tests
  don't wait on real backoff.
- **Timeouts** (`node.timeoutMs`) — races the executor against a timer;
  applies independently to every retry attempt.
- **Branching** — a `condition` node's boolean output selects which of its
  outgoing edges (`true` / `false`) is followed.

Executors are injected as a `NodeExecutorMap`, keyed by node type, so the
engine itself never touches the network, a clock, or a database — that's
what keeps it a pure function and keeps the tests fast and deterministic.

### The 5 node types

`http_request`, `transform`, `condition`, `delay`, `llm`. Built-in executors
for the first four live in `executors.ts`; each is a factory that takes its
I/O dependency (`fetch`, `sleep`) as a parameter so it can be faked in tests.
`transform`/`condition` evaluate a JS expression from `config.expression`
against `{ input, context }` — fine for a trusted, single-user tool, and
flagged here because it would not be fine for anything multi-tenant.
`llm` only has its provider interface defined (`LLMProvider`) — Ollama and
hosted-API implementations are Phase 6 work.

### Deliberately not built yet

- No GraphQL — Phase 2 ships REST; GraphQL is layered on top of the same
  handlers once Phase 3's UI needs nested queries (see `project.MD`).
- No canvas/editor UI, no run history UI — Phase 3.
- No structured logging, no Sentry, no CI — Phase 4.
- No real LLM provider implementations — Phase 6.
