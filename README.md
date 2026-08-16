# Webhook Automation Runner

A self-hostable tool that runs small automations — triggered by a webhook or a
schedule — with a visual editor and a run history that tells you exactly what
happened.

## Status: Phase 1 — data model and execution engine

Phase 1 is deliberately UI-less and API-less: just the Postgres schema design
and a pure, unit-tested execution engine. Everything here runs without a
database connection.

```
src/
  db/
    schema.ts        Drizzle schema: workflows, nodes, edges, runs, node_executions
  engine/
    types.ts          Core types: WorkflowDefinition, RunResult, NodeExecutor, ...
    plan.ts            buildExecutionPlan — topological sort + cycle detection
    engine.ts          executeWorkflow — runs a plan against a trigger payload
    executors.ts       Built-in executors for the 5 node types
tests/
  plan.test.ts
  engine.test.ts
  executors.test.ts
```

### Running the tests

```
npm install
npm test        # 42 Vitest tests, no database required
npm run typecheck
```

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

- No database wiring — `schema.ts` defines the tables, nothing reads/writes
  them until Phase 2.
- No GraphQL API, no webhook endpoint, no job queue — Phase 2.
- No canvas/editor UI, no run history UI — Phase 3.
- No real LLM provider implementations — Phase 6.
