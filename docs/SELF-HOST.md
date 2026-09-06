# Self-hosting Gajae Code App

Gajae Code App is self-hosted from the **GitHub Releases** server artifact only:

<https://github.com/devswha/gajae-code-app/releases>

The canonical artifact is
`gajae-app-server-<version>-linux-x64-node22.tar.gz`, accompanied by an
artifact with the same name plus `.sha256`. Do not substitute a package
registry, container image, desktop delivery, or an unverified source build.

## Supported target and filesystem layout

The first supported artifact target is Linux on x86_64 with glibc 2.35 or
newer and a Node.js 22 runtime. It is a server artifact only.

| Path | Purpose |
|---|---|
| `~/.local/share/gajae-app` | Canonical Git checkout for source review and manual upstream intake. It is not a release payload. |
| `~/.gajae-app/releases/<version>` | Immutable unpacked server artifacts. |
| `~/.gajae-app/current` | Symlink to the release used by the service. |
| `~/.gajae-app/data` | Persistent application data, including user-managed database, assets, and cache paths. |
| `~/.config/systemd/user/gajae-app.service` | Per-user systemd service. |

A release deployment must never create, replace, or delete the checkout.
Likewise, replacing a release must not delete `~/.gajae-app/data`.

Before the first deployment, confirm the host contract:

```sh
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
getconf GNU_LIBC_VERSION    # requires glibc 2.35 or newer
node --version              # requires v22
```

Use the release-install procedure in [INSTALL.md](INSTALL.md) to verify the
checksum, unpack a versioned release, install `gajae-app.service`, and activate
the initial `current` link.

## Service operations

Gajae Code App runs as the per-user `gajae-app.service`; root privileges and a
system-wide unit are not required.

```sh
systemctl --user status gajae-app.service
systemctl --user restart gajae-app.service
journalctl --user -u gajae-app.service -f
curl --fail http://127.0.0.1:3001/health
```

Use `loginctl enable-linger "$USER"` only when the host policy permits the
service to continue after logout.

Keep the service on loopback unless remote access is deliberately required.
Prefer a trusted VPN or an SSH tunnel; do not expose the server by raw public
port forwarding.

```sh
ssh -N -L 3001:127.0.0.1:3001 user@server
```

## Managed GJC chat in an existing Herdr

Normal new GJC chat provisions an App-owned workspace/tab/pane in the selected
**existing** current-user Herdr. First-use ambiguity is resolved by the inline
Herdr selector; there is no focused-pane guess. A selected but unavailable
Herdr blocks chat rather than starting a local SDK, a second App server, or
another Herdr. Imported non-managed sessions are not adopted or mutated.

One independent Node task host in that pane owns one pinned Bun SDK child.
The real provider session must be ready before the App publishes its mapping
and submits the prompt. Lost provisioning RPC replies mean **unknown**, not
permission to create another workspace, pane, or SDK owner.

The independent host publishes `gjc` and its display status through
`pane.report_agent`. Its **only Herdr identity-correlation channel** is the
official `pane.report_metadata` API: `gajae_native_session_id`,
`gajae_owner_generation`, and `gajae_app_session_id` in the owned pane's
`tokens`. Publication uses the actual initialized SDK ID, an owner-specific
source and increasing sequence numbers; the host confirms the values in a
fresh snapshot. A bare RPC acknowledgement is not publication proof.

These tokens are correlation metadata, **not command authorization or native
Herdr resume support**. The App's authenticated private binding remains the
authority. Reserved `agent_session` admission and native Collie history/resume
are not required or impersonated. On confirmed owner closure, the host clears
only its still-matching namespaced values and releases only its source.
Replacement identities and unrelated token keys are preserved. These are local
preflight guards, not an atomic metadata compare-and-swap guarantee.

App quit, server-client detach, or browser disconnect does not terminate this
managed owner. Ordinary coding, file operations, commands, asks, and permissions
can continue through the Herdr/Collie R2 console. App-dependent browser/screen
steps wait on the original SDK callback: reconnect must renew a capability for
the actual target and obtain explicit resume approval. Reattachment alone is
not approval. Recovery accepts an authoritative completed receipt or a fenced
not-dispatched result; a reserved/unknown attempt remains unknown, never replayed.

### R2 console and uncertain outcomes

Use `:help` and `:status` in the owned pane. Status exposes the safe owner,
active-turn and queued-action identities needed for console-only control.
Current parser grammar is:

```text
:prompt ACTION STATE_REVISION "JSON text"
:followup ACTION "JSON text"
:steer ACTION TURN "JSON text"
:abort ACTION TURN
:answer ACTION APP/GENERATION/PROVIDER/TURN/REQUEST "JSON answer"
:permission ACTION APP/GENERATION/PROVIDER/TURN/REQUEST POLICY_REVISION allow-once
:resume ACTION APP/GENERATION/PROVIDER/TURN/REQUEST CAPABILITY_GENERATION approve
:ack ACTION
:status
:help
```

Permission decisions also accept `deny-once`, `allow-always`, and
`deny-remaining`; resume accepts `deny`. Copy the full five-part request identity
and current revisions from the host, never the newest or focused request.
Use the answer values offered by that request. SDK 0.15.6 implements multi-question and multi-select prompts using successive
scalar selector callbacks. Answer the current callback once; do not combine
several callbacks into an array or echo a replacement question schema.
Action IDs are 1–64 ASCII letters/digits/underscore/hyphen; identity components
are 1–160 of the same characters. Mutations require an action ID.

Input is one physical line, capped at 64 KiB UTF-8; JSON strings may encode
newlines (at most 256 logical lines). Bracketed paste containing raw newlines,
malformed UTF-8, and unsupported controls are rejected. Do not paste multiple
commands without bracketed-paste protection: ordinary newlines submit lines. Escape or
Ctrl-C cancels the draft, not the SDK turn; use `:abort` for a turn.
The owned physical TTY enters non-echoing raw mode before SDK initialization,
and enables bracketed paste when its output is also a TTY. Ctrl-D is input,
not owner shutdown. Input EOF/error detaches only that input and restores its
original raw mode and disables bracketed paste; App/attach disconnects do not
release the owned terminal. Owner close/exit also restores terminal settings.
Programmatic SIGINT, SIGTERM, or SIGHUP closes the independent owner gracefully,
waiting for private child disposal, its persistent writer and confirmed owned
metadata cleanup before marking closed.
The console does not echo payloads or retain input history. Secret-tagged
requests suppress their content; output sanitizes controls and known secrets,
but cannot recognize arbitrary secrets in prose. Never paste credentials into
an echoing shell or publish console/bootstrap dumps. The pinned SDK has no
supported no-save secret-answer hook: tagged ask answers fail closed and the
App offers refusal rather than an editable secret field. Ordinary question
answers can appear in native history; use a separate credential flow.

Herdr accepting bytes is not a host ACK. `ACK ACTION STATE SEQ` records
admission/execution/settlement, not necessarily successful task completion.
After a missing reply, use `:ack ACTION` and `:status` before any retry.
Unknown needs status and authoritative proof, **not restart-and-retry** or a
fresh action ID. Do not mutate foreign tasks to recover a managed one.
Closing the App's own `Gajae <install>` workspace in Herdr is safe: the next
new conversation notices it is gone and creates a fresh owned workspace. A
send that Herdr provably never dispatched (Herdr answered a request-validation
error and a fresh snapshot shows no new pane) reports the owner unavailable;
send again to provision a fresh owner. Any other failed or unanswered layout
stays an uncertain owner.
A fenced owner (`unknown`, `interrupted`) still answers `:status` and
`:ack ACTION` from what it durably knows, and rejects new commands with
`ACK ACTION rejected SEQ`; those replies are not journaled and nothing is
admitted. A reopened App attaches to such an owner read-only and shows the same
unknown receipts. When the exact owner process is confirmed gone (its recorded
pid no longer exists or belongs to a newer process), the App marks that
generation `interrupted`; an unreachable but live owner stays unknown, and no
replacement owner is started either way.

Console display output is lossy under backpressure: when the terminal falls
behind, display blocks are dropped behind one visible `OMITTED N display
blocks` marker while `ACK`/`REQUEST`/`REJECT`/`STATUS` records are kept in
order. Only critical-record overflow disconnects the console.

The App server projects mappings through a generation/sequence CAS. Project
policy writers share revision-checked storage; the live host alone resolves its
pending permission requests and commits winning Always grants, including while
the App is absent.
Archiving hides a conversation without stopping its owner. Permanent deletion
requires confirmed native closure and owned metadata cleanup; an active or
uncertain owner cannot be deleted or silently adopted. A project force-delete
is fenced the same way for every session it contains; the fence and the row
cascade are one writer transaction, and only the transcripts of the rows it
removed are unlinked afterwards. Native history, rich event
replay, and bounded paginated snapshots restore chat; terminal scraping does
not. Private bootstrap, attach tokens, and automation target paths stay
server-side, outside browser payloads and diagnostic logs. Tokens and prompt
contents must not enter argv; the host CLI receives only its protected
bootstrap locator. Keep private files outside the project, owner-only.
The server defaults to loopback and rejects unsafe exposure unless explicitly
configured under its exposure guard.

For managed computer use, the latest required `launch_app` change resolves an
exact installed `bundle_id`, binds canonical bundle identity, and revalidates
it before dispatch; an arbitrary application name is not target authority.
Resolution uses macOS's installed-application inventory without opening the app.
Missing or ambiguous installations and changed identities cannot launch under an
old approval. Launch uses the existing CUA session and its validated bundle ID,
not a direct OS-command path around driver revocation or suspension. A rejected
session is not silently renamed to regain authority. Successful dispatch reports
`launchRequested: true` after the driver accepts the request, not a fabricated PID.
An explicit `CUA_DRIVER_PATH` is never replaced silently by another discovered
installation. Transport loss after a possible dispatch remains unknown; only a
verified driver response can settle it. Denied approval request IDs are consumed,
so another viewer cannot approve the same request afterward.
This is a product contract, not evidence of an executed installed-app test.

## Non-managed Herdr observer/input boundary

When Herdr is installed for the same user, Gajae Code App can list admitted
current-user Herdr API sockets under `$XDG_CONFIG_HOME/herdr` or
`~/.config/herdr`, read selected-pane visible plain text, and send explicit
bounded input. Gajae Code App does not start, stop, upgrade, rename, focus, or
repair Herdr. The observer does not migrate Herdr panes into SDK chat sessions;
managed provisioning above only creates explicitly App-owned placement.
Collie remains an independent client.

The browser never supplies a socket path. It selects an admitted session name
and pane id; the server resolves those through its own registry. Output reads
use Herdr `pane.read` with `source: "visible"` and `format: "text"` so routine
refreshes do not harvest scrollback or move the operator's terminal. Treat the
result as the current viewport, not conversation history.

Input is intentionally narrow: one-line text, Send + Enter, Enter-only, or
Escape. Text cannot contain control characters or newlines and is capped at
16 KiB. Gajae revalidates the observed pane before dispatch and serializes its
own same-pane submissions, but Herdr's public input request carries only
`pane_id`, `text`, and `keys`. That check is local preflight, not atomic
compare-and-send. A successful reply means Herdr accepted bytes; it does not
prove delivery, target continuity, or task completion. Timeouts after a write
may have happened are reported as unknown and are never retried automatically.

## Cutover to a verified release

A cutover changes only the `current` symlink and then restarts the service.
Download and checksum-verify the next artifact exactly as described in
[INSTALL.md](INSTALL.md); do not use a moving `latest` URL.

1. Record the active release before touching `current`.
2. Unpack the verified artifact into its new
   `~/.gajae-app/releases/<version>` directory.
3. Confirm that the expected server entry point is present.
4. Atomically replace `current`, restart the service, and check both systemd
   state and the health endpoint.
5. Keep the prior release directory until the new release is accepted.

```sh
RUNTIME="$HOME/.gajae-app"
VERSION=<approved-version>
RELEASE_DIR="$RUNTIME/releases/$VERSION"
PREVIOUS="$(readlink -f "$RUNTIME/current")"

test -f "$RELEASE_DIR/dist-server/server/index.js"
printf '%s\n' "$PREVIOUS" > "$RUNTIME/previous-release"
ln -s "$RELEASE_DIR" "$RUNTIME/current.next"
mv -Tf "$RUNTIME/current.next" "$RUNTIME/current"

systemctl --user restart gajae-app.service
systemctl --user --no-pager --full status gajae-app.service
curl --fail http://127.0.0.1:3001/health
```

If the service or health check fails, perform the rollback immediately rather
than troubleshooting against a partially accepted release.

## Rollback

`previous-release` contains the release path captured by the cutover commands.
Validate it is an installed release before atomically restoring it.

```sh
RUNTIME="$HOME/.gajae-app"
PREVIOUS="$(<"$RUNTIME/previous-release")"

case "$PREVIOUS" in
  "$RUNTIME"/releases/*) ;;
  *) printf '%s\n' "Refusing an unsafe rollback target: $PREVIOUS" >&2; exit 1 ;;
esac
test -f "$PREVIOUS/dist-server/server/index.js"

ln -s "$PREVIOUS" "$RUNTIME/current.rollback"
mv -Tf "$RUNTIME/current.rollback" "$RUNTIME/current"
systemctl --user restart gajae-app.service
systemctl --user --no-pager --full status gajae-app.service
curl --fail http://127.0.0.1:3001/health
```

Record the failed version and the rollback result in the deployment record.
Do not remove either release until the rollback health check succeeds.

## Removal boundary

To remove the service and release payload while preserving user data:

```sh
systemctl --user disable --now gajae-app.service
rm -f "$HOME/.config/systemd/user/gajae-app.service"
systemctl --user daemon-reload
rm -rf "$HOME/.gajae-app/releases"
rm -f "$HOME/.gajae-app/current" "$HOME/.gajae-app/previous-release"
```

This intentionally leaves `~/.gajae-app/data` and
`~/.local/share/gajae-app` untouched. Back up or remove either path only
through an explicit, separately reviewed data-retention decision.

## Source and upstream boundaries

The checkout at `~/.local/share/gajae-app` is for source review and deliberate
maintenance work. It is never the service working directory and is never
updated as part of a release cutover. Follow [UPSTREAM.md](UPSTREAM.md) for
manual, selective upstream intake; automated mirroring or synchronization is
not permitted.
