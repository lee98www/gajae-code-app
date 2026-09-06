# GJC live provider specification

Status: Bun SDK worker, native host/watcher, durable jobs, native PTY, and
managed Herdr chat source contracts (updated 2026-09-06).
Installed/copied-package acceptance for the managed changes remains pending.

GJC is the only provider routed through an isolated provider worker. Claude,
Codex, Cursor, and OpenCode retain their existing execution paths.

## Managed normal-chat ownership

New managed GJC chat uses `herdr-managed-workspaces.ts` and
`herdr-managed-chat.ts`: inline first-use selection chooses an admitted existing
Herdr, then provisions App-owned placement without a second App server, a
focused-pane guess, or mutation/adoption of imported non-managed tasks.
A selected unavailable endpoint blocks; no local-spawn fallback is permitted.
CAS reservations and endpoint/placement identity checks prevent duplicate
owners. Lost RPC outcomes stay unknown and cannot automatically replay
workspace/layout creation. The registered owned parent workspace is verified
by a fresh snapshot before every append: present under the exact owned label
it is reused; definitively absent or relabelled it is superseded by a new owned
workspace, never adopted; unreadable it stays unknown. The same ownership is
bound to the append itself: `layout.apply` targets the registered id under the
owned label, the pre-dispatch snapshot must show exactly that, and the receipt
must map back to it, or the outcome stays unknown. A rejection of
`layout.apply` is a known non-dispatch only with two independent proofs: Herdr
answered one of its request-validation codes (`workspace_not_found`,
`tab_not_found`, `invalid_target`, `invalid_layout`, `invalid_env`; Herdr 0.8.0
returns these before any tab or pane is created) and a fresh snapshot shows the
workspace gone or its pane set unchanged. Only then is that empty, unclaimed
generation released for a fresh reservation on the next send. A
`layout_apply_failed` answer, a lost reply, a timeout or an unreadable snapshot
stays unknown.

The pane's independent Node `gjc-herdr-task-host.ts` owns one pinned Bun
`gjc-herdr-managed-child.ts` SDK session. Readiness requires the real provider
session ID; only then may the App project the mapping and submit a prompt.
Schema initialization and project permission policy remain App-owned;
mapping/projection writes require generation-fenced CAS. Neither gives the
App process ownership of the task-host lifetime. Its quit or browser
disconnect detaches clients. Ordinary coding, files, commands, asks, and
permissions continue with the same native callbacks through Herdr/Collie.
Archiving hides the App conversation without stopping its owner. Permanent
deletion, including project force-delete, remains fenced until native-writer
closure and owned metadata cleanup are confirmed; UI disconnection is not a
lifecycle command. A project force-delete admits and cascades in one writer
transaction, so no reservation, claim or closure can interleave between the
fence and the deletion, and it discards only the transcripts of the rows that
transaction removed.

Herdr publication is host-owned: `pane.report_agent` carries `agent: gjc` and
idle/working/blocked/unknown status; `pane.report_metadata` carries the
namespaced `gajae_native_session_id`, `gajae_owner_generation` and
`gajae_app_session_id` correlation tokens. The actual SDK ID is published only
after readiness and verified owned placement. A fresh snapshot must show the
expected tokens and label/status before publication is reported as confirmed.
Reserved `agent_session` fields are neither sent nor required. Generic tokens
do not authorize commands or enable native Herdr/Collie resume/history.
Cleanup checks physical target and matching token values before clearing only
those keys, then releases the same owner-specific source after native closure.
Foreign values are never adopted; guards do not claim atomic compare-and-send.

Native history and rich ordered events, with immutable bounded paginated
snapshot recovery, are chat authority—not a terminal scrape. Request resolution
is bound to app session, owner generation, provider session, turn, and request,
plus current policy/capability revisions. The concrete R2 grammar, bounded
paste/no-echo rules, and ACK troubleshooting are in
[SELF-HOST.md](../docs/SELF-HOST.md#r2-console-and-uncertain-outcomes);
`gjc-herdr-task-console.ts` is the parser authority. Snapshot pages advance
with socket progress rather than a full-history burst; concurrent journal
changes follow the immutable watermark or a newer authoritative replacement.

SDK 0.15.6 implements multiple questions and checkbox selection through
successive scalar UI callbacks. Its supported AskTool/UI API has no
secret/no-echo/no-history answer hook. Tagged ask answers are therefore
rejected before live delivery; the UI offers refusal, not password entry.
Redaction of tagged permission inputs is not a promise that arbitrary
credentials entered into an ordinary question will stay out of native history.

A fenced owner (`unknown`, `interrupted`, `closed`) is still recoverable
read-only: a reopened App attaches to an already-published owner without
re-promoting readiness, `status`/`ack` queries and rejected commands are
answered from durable state without being journaled, and no prompt is admitted
or replayed. A private attach failure alone never fences a generation. The host
records its exact process identity (`owner.json`: pid plus kernel start time)
next to its attach socket; a reopened App confirms owner death only when that
recorded process no longer exists or its start time differs, marks the
generation `interrupted`, and keeps the claimed target, journal and private
files; the same confirmation fences a host that claimed its generation before
its placement was captured. A live but unreachable owner stays unknown. The
host's private SDK child reports between-turn runtime state as bounded
`managed.idle` records journaled as `sdk.idle`, never silently dropped and
never presented as a live turn event. The SDK carries no turn identity on its
callbacks; a tool started by one turn whose update arrives under a later
prompt is recorded the same way under the turn that started it, never
attributed to the active prompt. The wrapped event crosses the ordinary
publication boundary first (protected automation payloads, redacted known
tokens), a fenced owner's journal silently declines it, and any other
persistence failure fails the private transport instead of acknowledging a
lost event. The child escalation path fences a failed claim only after the
child's exit is observed. Appending owned placement into
an already-focused owned workspace is valid; focus is verified by comparing the
focused identities before and after the append.

The owner's configured model is durable. An App turn carrying the ambient
`default` model does not switch an owner that already reports a configured
model; only an explicit per-session pin or an explicit model choice changes it.
A prompt the SDK rejects outright settles `unknown` with the SDK's bounded,
secret-redacted reason in the receipt message, and the owned console prints the
`ACK ACTION unknown SEQ` record plus an `ERROR` line carrying that reason for
whichever client started the turn (`:ack` repeats both); a console-entered
turn that ends unknown is never additionally reported as a rejected command.

App-dependent automation waits on the original SDK callback while disconnected.
Renewal binds the actual browser/application target and requires explicit
resume approval. Only authoritative completed receipts or fenced
not-dispatched outcomes permit recovery; an existing reservation with unknown
outcome is not replayable. Missing command replies require status/ACK lookup,
not restart, a new action ID, or a replacement task. A denial consumes its
approval request; another viewer cannot approve that same request afterward.
Verified driver rejections are known outcomes, but post-write transport loss
or malformed driver replies remain uncertain. An explicit `CUA_DRIVER_PATH`
is authoritative and never silently falls through to another installation.

The latest required managed `launch_app` contract uses an exact installed
bundle ID, a private canonical-path/identity binding and predispatch
revalidation, never an arbitrary name. That requirement is not an
executed/verified installed-app claim. Bootstrap/attach secrets and private
paths are protected server-side; prompts/tokens are not command-line arguments
or browser/log payloads (the host receives a protected bootstrap file locator).
The App exposure guard defaults to loopback and fails closed.

## Non-managed headless GJC contract

Production starts the pinned Bun runtime and `server/gjc-bun-worker.ts` behind
the native core. The worker creates `@gajae-code/coding-agent` sessions through
`server/gjc-bun-sdk-adapter.ts`; it does not spawn the `gjc` CLI.

- `cwd` is the selected project path.
- Prompts cross the private worker protocol on stdin and are passed to the SDK
  in process. They are never placed on a process command line.
- Authentication and configuration come from the user's normal GJC
  configuration; the worker verifies the bundled runtime manifest before
  creating a session.
- Application/worker traffic is byte-bounded NDJSON. Worker stderr is
  diagnostic only and is not forwarded to browser clients as raw provider
  output.
- Controlled questions, approvals, steering, usage, OAuth, and abort are owned
  by the SDK adapter. Production has no CLI or loopback-side-channel fallback.

## Production boundary

### Application process

For the non-managed execution path, `server/gjc-worker-client.ts` is the
production GJC execution facade used by `server/index.js` and
`server/routes/agent.js`. It owns:

- one lazily started, long-lived native-core and worker generation;
- application session scope and immutable run IDs;
- browser-facing normalized events, replay sequencing, and provider-session
  persistence through `ChatSessionWriter`;
- the synchronous mirror of pending controlled questions;
- run notifications and explicit failed-turn fallback;
- generation restart, request timeout isolation, graceful shutdown, and
  process-tree escalation.
- one supervised native GJC transcript watcher with bounded restart backoff.

There is no direct in-process or direct-Node-worker production fallback. A
missing or failed native core, malformed output, or worker exit fails active GJC
runs explicitly; a later run starts a fresh generation only after cleanup is
proven.

### Native core process

`native/gajae-core` is a minimal Rust runtime with two strict modes. The
application starts `dist-native/gajae-core -- <worker>` to host exactly one
trusted Node worker without a shell, and starts `dist-native/gajae-core watch`
for GJC transcript changes. In process-host mode, the core:

- inherits the application-controlled environment and working directory;
- forwards application stdin to worker stdin without interpreting Protocol v1;
- gives the worker byte-transparent stdout/stderr pipes and waits for its exit;
- propagates deterministic child exit status and emits only fixed diagnostics;
- has no listener, database, provider logic, persistence, or independent restart
  policy.

Source development builds the core before startup. Release artifacts contain the
host-native executable and do not require an installed Rust toolchain. Failure to
build, locate, or launch the core is fail-closed; Node never launches the worker
directly.

### Native GJC session watcher

`server/modules/providers/services/gjc-session-watcher.service.ts` starts
`gajae-core watch` over the persisted `~/.gjc/agent/sessions` root and the
configured live-session root before the initial provider scan. The watcher:

- rejects missing, relative, duplicate, symlink, or non-directory roots;
- attaches all roots recursively before emitting its exact ready frame;
- canonicalizes event targets and emits only UTF-8 `.jsonl` `add`/`change` paths
  whose resolved filesystem identity remains inside a configured root over a strict
  64 KiB Protocol 1 NDJSON stream;
- uses bounded native and Node queues, serial cancellable callback delivery, fixed
  path-free diagnostics, and stdin EOF for owner shutdown;
- restarts with bounded exponential backoff, runs a GJC-only reconciliation after
  each replacement is ready, and never falls back to a Node/Chokidar GJC watcher.

The existing GJC TypeScript synchronizer remains responsible for defense-in-depth
realpath containment, subagent filtering, JSONL parsing, session database upserts,
and browser `session_upserted` events. Claude, Codex, Cursor, and OpenCode retain
their existing Chokidar watchers unchanged.

### Native job authority

`gajae-core jobs --database <absolute-path>` is a separate strict 64 KiB
Protocol 1 NDJSON API and the single state-machine authority for durable jobs.
Its state and ordered event replay persist in a dedicated Rust-owned SQLite
database built with bundled SQLite. Rust exclusively owns its version table and
sequential migrations; Node must not open this database. Invalid paths, unknown
schema versions, migration failures, or corrupt state fail closed. Explicit
transitions remain fenced by monotonically generated owner leases, and startup
reconciliation moves persisted active jobs to `interrupted`. Native Git/worktree
APIs, the TypeScript `JobOrchestrator`, and its admission saga are landed
components only: production GJC execution remains on the single-turn worker
facade. Automatic capacity dispatch, multi-turn continuity, and branch/PR work
from managed worktrees are deferred to Slice 3. Worker Protocol v1 and all React
behavior are unchanged.

### Native PTY lifecycle

`gajae-core pty -- <program> [args...]` owns exactly one native PTY child and
launches it directly without shell interpretation. Its separate Protocol 1
NDJSON control stream is capped at 64 KiB per frame; binary input/output uses
bounded base64 payloads, resize dimensions are validated, and output, exit,
stdin EOF cleanup, and explicit shutdown are observable. The existing
browser-shell `node-pty` path has not moved in this slice, so React and current
terminal behavior remain unchanged.

### Worker process

`server/gjc-bun-worker.ts` is the private production executable.
`server/gjc-worker.ts` supplies its protocol host. Together with
`server/gjc-bun-sdk-adapter.ts`, they own:

- bundled runtime verification and SDK session creation;
- authentication, OAuth, controlled asks, approvals, steering, usage, and
  abort;
- start/resume completion ordering and provider-session discovery;
- draining or aborting active runs when shutdown, stdin EOF, or protocol failure
  occurs.

The worker does not own or mutate application database, browser WebSocket,
replay, or notification state.

### Identity model

Three IDs are intentionally separate:

1. `appSessionId` is the stable Gajae Code App session and protocol scope.
2. `runId` is generated for every start/resume request and is the immutable
   abort/event correlation handle.
3. `providerSessionId` is the native GJC session used for resume and history.

Every run event carries `sessionId: appSessionId` in the envelope and `runId` in
its payload. `session.created` adds `providerSessionId`. Late events for an old
run are ignored even when a new run reuses the same application session.

## Protocol v1

`server/gjc-worker-protocol.ts` is the source of truth. Transport is private
stdio NDJSON with a strict 64 MiB maximum frame size.

```json
{
  "protocolVersion": 1,
  "kind": "request",
  "id": "run-or-request-id",
  "sessionId": "application-session-id",
  "method": "session.start",
  "payload": {}
}
```

The full method list, session scoping, error codes, lifecycle and conformance
rules are specified in [docs/GJC-WORKER-PROTOCOL.md](../docs/GJC-WORKER-PROTOCOL.md),
which is written so either side can be implemented from it alone.

That document is checked against the code by
`server/gjc-worker-protocol-spec.test.ts`. This section deliberately no longer
repeats the method list: the copy that used to live here had gone stale, listing
neither `turn.steer` nor any `oauth.*` method, which is what an unchecked second
copy does.

The codec rejects unknown fields, methods, unsafe identifiers, incompatible
versions, invalid JSON values, mismatched responses, oversized or unterminated
frames, and unknown response IDs. Pending requests fail when the worker exits.
Diagnostics and protocol errors use fixed safe text; supplied secrets are
redacted recursively by the serializer.

## Tool permissions

The runtime gates `bash`, `monitor`, `eval`, `delete`, `move` and destructive
`edit` intents behind `AgentSession.setSdkPermissionMode` /
`setSdkPermissionProvider`. Its SDK default is `allow`, so a session the app
does not configure runs those tools unprompted.

The application decides per project and the worker enforces. No protocol
method or frame changes; the policy travels inside existing payloads:

- `session.start` / `session.resume` options may carry
  `permissions: { mode: 'ask' | 'auto_edits' | 'bypass', allowAlways: string[] }`
  (`server/gjc-permission-policy.ts`). When present the adapter switches the
  session to `prompt` and installs `server/gjc-bun-permission-gate.ts`; when
  absent the runtime default stands. A malformed block fails the run with the
  application error code `invalid_permissions` — a start failure whose cause
  the app itself produced — and the application relays the fixed text
  "Invalid GJC run permissions." to the client instead of the generic
  "GJC worker failed.".
- A run's model must pair with a credential the runtime can use. Stored rows
  pin deterministically as before; a provider with **no** stored row is still
  eligible when the auth layer can resolve a key for it (`models.yml`
  `apiKey`/`apiKeyEnv`, env fallback — probed via `peekApiKey`, which resolves
  nothing), and such a run starts with no `credentialSelector` so the runtime
  authenticates the provider itself, exactly as the CLI does. When nothing
  resolves — a default role pointing at a provider nobody can sign in to, or a
  pinned model on one — the run fails with the application error code
  `model_unresolved` (`server/gjc-model-resolution.ts`) and the application
  relays the fixed text "The GJC model could not be resolved. Check the model
  selection and provider sign-in, then try again.".
- A call the policy covers (`bypass`, a tool on `allowAlways`, or a file
  mutation under `auto_edits`) is approved inside the worker and recorded once
  per tool per run as a `system_notice` ("Auto-approved bash (always allow)").
  Nothing crosses to the host, so the run is never reported as awaiting input.
- Any other gated call is an `ask.presented` event whose message is a
  `permission_request` with `requestId` prefixed `sdk-permission:`, the
  runtime's `toolName`, its `rawInput` as `input`, and a `context` naming the
  runtime option kinds. `ask.reply` answers it with
  `decision: { allow: boolean, always?: boolean }`; `always` maps to the
  runtime's `allow_always` option for the rest of that run, and the application
  persists it to the project's allow-list before forwarding the reply.
- `ask` questions keep their `sdk-ask:` prefix and answer semantics.

## Non-managed process and terminal lifecycle

- On POSIX (Linux and macOS), the application starts the Rust core as a detached
  process-group leader. The Node worker and GJC children inherit that group;
  reaping requires direct-child close and process-group `ESRCH`.
- Windows is a v2 non-target and runtime-frozen per this brief: CI and a
  verified desktop machine are unavailable. No `taskkill /T /F` fallback is
  part of the v2 contract. Windows cleanup is fail-closed as `unconfirmed`, so
  it cannot release a lease or admit a replacement generation.
- `worker.initialize` covers the whole SDK bootstrap (runtime manifest check,
  model registry build, online model discovery), which takes several seconds on
  a loaded machine. The application bounds it at 60 s
  (`DEFAULT_INITIALIZE_TIMEOUT_MS`), separately from the 5 s `worker.shutdown`
  bound; a worker that misses it is reaped and the reason is written to
  `~/.gajae-app/logs/gjc-worker.log` and the server output, while callers see
  the sanitized failure.
- A start/resume response remains pending until the GJC run settles and all
  earlier worker events have been emitted.
- `turn.abort` targets `runId`; the worker time-bounds the SDK attempt before
  direct child-signal fallback. The application marks a run aborted only after
  the worker confirms `aborted: true`; failed or timed-out aborts leave it active.
- Exactly one terminal browser event is forwarded. If the worker dies before
  producing one, the application emits one sanitized error and one failed
  completion.
- Usage enrichment, SDK bridge closure, and installation probes are bounded;
  `complete` remains the final run event even when optional dependencies stall.
- Application shutdown sends `worker.shutdown`, waits for bounded run drain,
  then terminates the owned worker tree.

## Verification contract

Managed verification is tracked separately in
[DESKTOP-TAURI-VERIFICATION.md](../docs/DESKTOP-TAURI-VERIFICATION.md#managed-herdr-chat--current-source-acceptance-pending).
Its PTY/imported-fixture lifetime harness is not a production Herdr CLI probe,
default SDK readiness is not DOM verification, and earlier packaged release
records do not verify these current managed changes.

Focused coverage is in:

- `server/gjc-cli.test.ts`
- `server/gjc-sdk-client.test.ts`
- `server/gjc-sdk-bridge.test.ts`
- `server/gjc-core-host.test.ts`
- `server/modules/providers/tests/gjc-session-watcher.test.ts`
- `native/gajae-core/src/lib.rs`
- `server/gjc-worker-protocol.test.ts`
- `server/gjc-worker.test.ts`
- `server/gjc-permission-policy.test.ts`
- `server/gjc-bun-permission-gate.test.ts`
- `server/gjc-windows-job.test.ts`
- `server/gjc-worker-client.test.ts`
- `server/modules/websocket/tests/chat-run-registry.test.ts`

Coverage includes start/resume, split and bounded worker NDJSON, SDK asks and
replies, timeouts, abort fallbacks, terminal races, malformed worker output,
response correlation, stale-run isolation, worker restart, native-core byte
relay and no-fallback launch behavior, real worker initialize/shutdown through
Rust, recursive multi-root transcript watching, strict watcher framing,
coalescing, ready/exit timeouts, bounded drain, graceful process drain, atomic
Windows Job Object launch, failed cleanup admission blocking, and process-tree
cleanup. Full repository verification includes Cargo fmt, Clippy, and tests and
must continue to pass on supported Node.js 22 and 24 source runtimes.
