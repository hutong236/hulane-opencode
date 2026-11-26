# OpenCode adapter

Talks to an OpenCode server for the Workbench: sessions, prompts, messages, events, abort, agents, and a server the
Workbench starts and stops itself.

## The version this was read from

**OpenCode 2.2.7.** Every route, answer and error below was taken from a real server of that version on 2026-11-26,
started from the installed CLI in temporary repositories with a home and data directories of their own. The same
real cases also run on the Linux x86_64 runner of Workbench CI. Nothing here comes from documentation.
Another version is refused with `incompatible_version` until someone has read it the same way and updated this
package.

| What | How the 2.2.7 server does it |
| --- | --- |
| Where | Everything is under `/api`. Any other path gets the web page, with status 200: a health check that only looks at the status code passes on a page. There is no `/api/health`. |
| Health and version | `GET /api/info` answers `{ version, pid, hostname, urls, paths, capabilities }`. |
| Credentials | `OPENCODE_PASSWORD` on the server; the client sends `opencode:<password>` as Basic auth. Wrong or missing: `401 {"_tag":"UnauthorizedError","message":"Authentication required"}`. |
| Project | `x-opencode-directory: <canonical root>` on every request. A new session is bound to that directory, and the configuration of that directory is used (`GET /api/config` lists its `opencode.json`), whichever directory the server was started in. |
| Sessions together | `GET /api/session` lists sessions of **every** directory, whatever the header says. The `location.directory` of a session is what tells projects apart. |
| Create | `POST /api/session` `{ title }` answers `200 { data: session }`. A new session has no `agent` of its own. |
| Read | `GET /api/session/:id` answers `{ data: session }`; an id that is well formed but unknown is `404 {"_tag":"SessionNotFoundError"}`, a malformed id `400 {"_tag":"InvalidRequestError","kind":"Params"}`. Once an agent was switched to, the session has `agent`. |
| Which agent runs | The agent is a property of the session. `POST /api/session/:id/agent { agent }` answers `204`, and the session has that `agent` from then on. The server's default agent is `build`, which may edit files and run commands. **The `agent` field of a prompt does nothing:** a prompt sent with `agent: "workbench-readonly"` was run by `build`. The switch takes any name; an agent that is not there is switched to all the same, and the next task fails with `session.execution.failed` and `Agent not found: "…"`. |
| Prompt | `POST /api/session/:id/prompt` `{ text }` answers at once with the user's message: `{ data: { id: "msg_…", sessionID, type: "user", payload: { text }, delivery: "steer" } }`. The work is queued; the model's answer is not in this answer. |
| Messages | `GET /api/session/:id/message` answers `{ data: [...], cursor }`, the newest first. A `user` message has `text`. An `assistant` message has `agent`, `model`, `finish`, `cost`, `tokens`, a `snapshot` of the Git state, and `content` parts: `text`, `reasoning`, and `tool` with its `state`. There are also `idle` messages with an `outcome`, and `agent-switched` messages with an `agent`. Only the first page is read. |
| How a run ends | The events `session.execution.succeeded`, `session.execution.failed` (with `data.error`) and `session.execution.interrupted` (with `data.reason`). `session.execution.started` is not an end. |
| Asking first | When the agent wants something that asks first, as reading `.env`: the event `permission.asked` carries `data: { id: "per_…", sessionID, action, resources, … }`. `GET /api/session/:id/permission` lists what waits. `POST /api/session/:id/permission/:requestID/reply { decision: "reject" }` answers `204`; the key is `decision`. `reject` was read; `allow` was not tried. |
| What a task changed | `GET /api/session/:id/diff` lists the files a turn changed: `{"data":[]}` when it changed none. |
| Waiting | `POST /api/experimental/session/:id/wait` answers `204` at once for an idle session. What it does for a busy one was not read. |
| Never from here | `POST /api/session/:id/shell` runs one shell command in the session's working directory. The Workbench does not call it. |
| Stop | `POST /api/session/:id/interrupt` answers `{ interrupted }`. |
| Events | `GET /api/event` is `text/event-stream`: `data: {"id":"evt_…","type":"server.connected","data":{}}`, then `: heartbeat` lines and events such as `session.created`, `session.inbox.enqueued`, `session.execution.started`. |
| Remove | `DELETE /api/session/:id` answers `204`. Not used by the Workbench. |
| Agents together | `GET /api/agent` answers `{ location: { directory }, data: [agent] }`. The server loads the agents of a directory when the directory is **first listed**. Until then `GET /api/agent/:id` is `404 {"_tag":"AgentNotFoundError"}`, however long the server has been running. The first listing answers `[]` when it comes right after a start; the agent is found by name all the same (read on four servers). |
| One agent | `GET /api/agent/:id` answers `{ location, data }` with `{ id, name, mode, hidden, permissions }` and `description` where there is one: the server's own hidden agents `compaction`, `title` and `summary` come without it. `permissions` is a list of `{ action, resource, effect }` in order, and the last one that matches wins. The server's rules come first, the agent's after them. |
| Directory that is gone | `404 {"_tag":"LocationNotFoundError","location":{…},"message":"Location not found: …"}`. |
| Configuration in the environment | `OPENCODE_CONFIG_CONTENT` is one more configuration layer; `GET /api/config` lists it as a `document`. An agent under `agent` gets its rules applied. Under `agents` it is listed, and its rules are not applied. |
| Start | `opencode serve --hostname 127.0.0.1 --port 0` picks a port that is free and prints `server listening on http://127.0.0.1:<port>` on standard output. A port that is taken ends it with code 1 (`ServeError … Is port N in use?`). Started without `OPENCODE_PASSWORD`, it makes a password and prints `server password …`. |
| Stop | SIGTERM ended a real server in 66 ms, with code 143 (measured once). |
| Files | Starting a server, creating a session and queueing a prompt wrote nothing into the project. Everything went to the XDG data directory (`opencode/opencode.db`), so sessions are still there for the next server, with the agent they were switched to. |
| A model without configuration | A server that was given no provider has one: `opencode`, with the model `big-pickle`, at `https://opencode.ai/inference/openai/v1`, with the API key `public` and a price of 0 (`GET /api/provider`, `GET /api/model`). So a prompt is run by a real model wherever a server is started. Outside the XDG directories the server reads by `HOME` too: in a lab whose XDG directories were its own, the model loaded a skill from the user's `~/.claude/skills`. |

## What the adapter does with it

- One adapter belongs to one project directory. It never gives out, writes to or stops a session whose
  `location.directory` is another one, and it refuses a session the server binds elsewhere.
- The server address has to be an origin. One that is not on this machine has to be `https`, because the password
  travels with every request.
- A prompt carries its text and nothing else. The agent that runs it is the session's: `setSessionAgent` switches it
  and gives the session out only when the server says, on being read back, that it runs that agent now.
- `listSessions` gives the sessions of the project, the newest first, out of the list of every directory's.
- Every failure is one `OpenCodeError` with a stable `kind`: `unavailable`, `timeout`, `unauthorized`,
  `incompatible_version`, `not_found`, `invalid_request`, `refused`, `protocol`, `not_installed`,
  `directory_unavailable`, `exited`, `pid_mismatch`, `readonly_agent`.

### The read-only agent

The Workbench gives its tasks to one agent, `workbench-readonly`, and only when the server's own computed rules prove
it read-only. What was read from the real server to get there:

- The built-in `plan` agent calls itself read-only and is not: it denies `edit`, for one directory, and leaves `shell`
  allowed. `explore` and `general` allow `shell` too.
- A server rule that allows everything comes first. So the agent denies everything and then allows what it may do:
  `read` (with `*.env` and `*.env.*` asking first, as for every agent), `glob` and `list`.
- `read` has to be an object with its own patterns, after its `*`. A flat `read: "allow"` also allows `.env`, because
  it comes after the server's "ask first" rule for those files.
- `grep` runs ripgrep with `--hidden`, so it would search `.env` files without asking. It is not given.
- The rules are read back from the server after a start and resolved rule by rule (last match wins). Anything that is
  not denied explicitly counts as not read-only, including a tool nobody has listed, and a rule of the user's own
  configuration that comes after the agent's would be seen.

A managed server gets the agent through `OPENCODE_CONFIG_CONTENT`, so nothing is written into a repository or into
the user's own OpenCode configuration. Whatever the environment already had under that variable is kept, and an
agent of the same name is replaced.

**Read on the public model** (`WORKBENCH_REAL_MODEL_TEST=1`, three tasks, 2026-11-26). With the session switched to
`workbench-readonly` and the model `opencode/big-pickle`:

- Asked for the first line of `README.md`, it called `read` three times and answered the line. Every stored answer is
  attributed to `workbench-readonly`.
- Asked to create a file, it called no tool, said it had none for that, and `GET /diff` was empty.
- Asked to print `.env`, it asked first (`permission.asked`, `action: "read"`, `resources: [".env"]`).
  `decision: "reject"` ended that; the file's content is in no message.

None of the three changed a file in the project.

### A server the Workbench starts

`startManagedOpenCode` starts `opencode serve --hostname 127.0.0.1 --port 0` in the project directory and gives out
the server only after all of this holds:

1. It printed where it listens, and that is this machine under the address it was asked for.
2. `GET /api/info` answers the verified version.
3. The pid it reports is the pid of the process that was started. Another process on that port would be given the
   password with every request.
4. Its `workbench-readonly` agent is there and is proven read-only by its computed rules.

The program comes from the Workbench's environment (`WORKBENCH_OPENCODE_BIN`, `opencode` by default) and never from a
request. The password is made for the one server and stays in memory: it is not stored, not printed, and taken out
of anything the server printed. `stop()` sends SIGTERM and, after the stop timeout, SIGKILL.

What is kept of the process: its pid, its working directory, when it was started, and what `ps` said about it then
(start time, command line, parent). A process number belongs to the same process only while the start time is the
same.

`connectOpenCode` attaches to a server someone else started. Nothing is started or written there. The address and the
password are the ones the server was given, and the server is read-only for the Workbench only if it already has the
agent.

`endLeftoverServer` ends a server that an earlier Workbench process started and left behind, and only when the system
says that this is it: the same process number, started at the time that was recorded, with the command line of a
managed server. A process number alone is not proof, as it may belong to another process now. When it cannot be said,
nothing is signalled and false is returned.

## Tests

- `test/mock-server.mjs` is a server that behaves like the 2.2.7 server above. It is plain JavaScript so that
  `test/fake-opencode.mjs` can run it as the program a managed server starts, with the same command line and the same
  first line on standard output. `FAKE_OPENCODE_*` variables make it fail the way a real server can.
- `test/real-server.spec.ts` starts real servers from the installed CLI when it prints `opencode v2.2.7`, and is
  skipped when it does not. It compares the rules the real server computed for the read-only agent with the line the
  mock is built on. Workbench CI installs the same pinned CLI on its Node 22 leg, so they run on Linux there too: in
  [run 45762406845](https://github.com/hutong236/hulane-opencode/actions/runs/45762406845) both ran and passed, and
  only the guard for another installed version was skipped.
- 51 deliberate breakages of the source are each caught by a test: 25 of the managed server, 20 of the agent and
  client code, and 6 of the session agent and the session list. Five of the first 45 were not at first, and each one
  was a gap in the tests: a start that was expected to fail and did not left its server running; a branch that only a
  directory vanishing between two checks can reach; an assertion that took an error of the right kind with the wrong
  cause; a real server that was killed but never asked to end.
- `test/real-server.spec.ts` sends a prompt only in the test that `WORKBENCH_REAL_MODEL_TEST=1` asks for. Until
  2026-11-26 it sent one in every run, with the default agent, to the public model: about a hundred runs locally
  (not counted exactly) and 2 on CI, each cut short when the test stopped its server. The lab servers have a `HOME`
  of their own now too.

## Not done here

- Answering permissions. The read-only agent asks before it reads a `.env` file. Nobody answers through this adapter
  yet; the route and its `decision` are read, and the Workbench has to decide who does. A read-only task must not be
  given more for asking.
- The messages of a conversation. `getMessages` reads the user's own messages; the assistant's `content` parts are
  not read into anything yet.
- `grep` for the read-only agent. It can be given only after a run with a real model has shown how the server treats
  the "ask first" files in a search.
- A server that cannot be proved to be the one a record names is never signalled. The API reports it as left behind,
  with its process number, for a person to end.
- Windows. The managed server was read on macOS and on Linux only.
