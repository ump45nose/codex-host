# Experimental GitHub Copilot CLI Harness

Codexhost can use the **new `copilot` executable**, not the older `gh copilot`
extension, as an independent Desktop Agent. Install and authenticate the CLI on
the Host first; the adapter launches `copilot --acp --stdio` with the installed
CLI's own account and configuration. The plugin is packaged as
`github-copilot-cli` and loaded through the ordinary Harness plugin loader;
Host Runtime does not import it directly. If the CLI is outside normal executable
discovery, set `CODEXHOST_COPILOT_COMMAND` to its executable path.

The [Copilot ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
is in public preview. On the tested macOS installation of Copilot CLI **1.0.89**,
`initialize` advertises `session/load`, and `session/new` exposes a model catalog,
reasoning effort and `allow_all` settings through native configuration options.
The adapter maps these only when advertised and confirms each selection against
Copilot's response. Approvals are forwarded with native option IDs; unanswered,
superseded or cancelled approval requests fail closed. `allow-all` is an explicit
dangerous mode, never an implicit default. Fork, rollback, native commands,
usage and unattended full access are not advertised.

## Persistence boundary

Copilot's documented ACP `session/load` restores a session, but it does not
promise stable historical Turn IDs or a complete history API. To reconcile
Desktop Threads, this experimental adapter reads the native
`~/.copilot/session-state/<session-id>/events.jsonl` (or `COPILOT_HOME`'s
`session-state/`), observed in version 1.0.89. It verifies the session ID,
format version, workspace, user-event IDs, turn boundaries and tool-call pairs.
A new unprompted session can lack this file; a resumed session cannot. A live
prompt must add exactly one native user Turn with the submitted text. Unknown,
missing or damaged history is an error, not an empty replacement transcript.

Persisted user-event IDs remain stable across a tested two-turn conversation,
closing the ACP process, reloading the session and continuing a third turn.
Historical Turn outcomes remain **unknown**, because the event file does not
confirm the ACP completion reason. Recorded tool completions are projected
conservatively, and missing tool results are not invented. This private event
format is version-sensitive and may change without notice; the plugin should
not be described as generally compatible with every Copilot CLI version or
platform. Real-session checks cover normal completion, cancellation, continuation after
cancellation and context changes, including Host text projection. They do not
establish full Desktop UI adoption or all authentication and tool-result variants.

The Desktop Picker, Connections page, independent per-Agent Model/Thinking
preferences and Thread ownership use the shared plugin route; they do not
substitute official Codex or copy Copilot's credentials into the Host.

## Context and stopping

The Composer model menu offers `default context` and `long context` entries,
using the native `--context default|long_context` tiers rather than fixed token
counts. ACP 1.0.89 does not expose a context configuration option. The adapter
passes the tier when creating the ACP process and persists it in the native
Session locator. A context change on an idle persisted Session restores the
same native Session and confirms model, thinking and permission settings before
replacing the previous client. An unprompted Session is not saved by Copilot;
its replacement is created afresh and no native identity is committed to the
Host until the first persisted Turn. References without a tier use default context.

Model inspection queries each offered native model to collect its actual
reasoning options, then restores the inspection Session's initial settings.
The resulting per-model IDs drive both Desktop thinking controls and validation.

Cancellation before native prompt submission completes the Host Turn without
sending the prompt. After submission, ACP cancellation is allowed five seconds
to complete; otherwise the owned process is closed and the cancelled Turn ends.
The next operation restores the native Session. Streamed events contain immutable
snapshots so delayed Host consumption cannot mutate the initial item text.
