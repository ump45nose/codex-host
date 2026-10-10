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

## Model-specific Thinking and Context Size

Copilot ACP advertises `reasoning_effort` for the **currently selected Model**;
its choices can change when the Model changes. Inspection probes the available
Models in a disposable ACP Session, then exposes only the choices confirmed for
each Model in Desktop. The adapter re-reads native configuration after live
Model/Thinking changes, including when `auto` has no explicit Thinking choice.
Effort IDs stay native (`none`, `low`, `medium`, `high`, `xhigh`, `max`, or the
options supported by that Model); Desktop renders raw native IDs as readable
labels such as **Extra High**. An uninspected Model does not inherit choices
from another Model.

The native interactive CLI has a **Context Size** control (default or long
context on eligible Models), and its `--context` flag takes `default` or
`long_context`. However, **Copilot CLI 1.0.89 ACP does not advertise a context
configuration option**, and `session/set_config_option` rejects `context_tier`,
`contextTier`, and `context`. A completed ACP prompt launched with
`--context long_context` still recorded `contextTier: null` in its native session start
metadata: this does not verify a 1M window. CodexHost's shared Harness
configuration protocol currently has no context-size selection command or
state. Consequently this plugin does **not** show a 272K/1M picker or claim
to set or confirm 1M; those numeric capacities are Model-dependent. Use the
native Copilot CLI to select a tier until an upstream ACP control with a
verifiable effective result and a Host configuration contract exist. No user
configuration is rewritten by this plugin.

## Stop and live controls

Stop requests native ACP `session/cancel`, which acknowledges a notification, not
completion. The adapter waits for the prompt's terminal response; if it does
not arrive within five seconds, it closes **only its owned Copilot ACP process**
and faults that Session. It never resubmits a prompt whose delivery is uncertain.
A Stop before the prompt is submitted does not send a native cancel. Native
`cancelled` results do not require an invented persisted Turn ID, whereas a
successful result must reconcile to exactly one native Turn.

Model, Thinking and Permission Mode can be selected for a draft or an **idle**
loaded Copilot Thread when its ACP configuration advertises the option. The
adapter refuses configuration changes while a Turn is active rather than
claiming mid-Turn changes took effect; finish or Stop the Turn first, then
select the next Turn's settings. Copilot's Permission Mode maps Supervised to
native `allow_all=off` and Allow all to `allow_all=on`; the latter is dangerous.

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
platform. The real-session test did not establish full Desktop UI adoption or
all authentication, cancellation and tool-result variants.

The Desktop Picker, Connections page, independent per-Agent Model/Thinking
preferences and Thread ownership use the shared plugin route; they do not
substitute official Codex or copy Copilot's credentials into the Host.
