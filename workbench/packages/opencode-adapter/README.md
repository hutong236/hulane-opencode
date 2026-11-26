# OpenCode adapter

Talks to an OpenCode server for the Workbench: sessions, prompts, messages, events, abort.

## The version this was read from

**OpenCode 2.2.7.** Every route, answer and error below was taken from a real server of that version on 2026-11-26,
started from the installed CLI in a temporary repository with its own data directories. Nothing here comes from
documentation. Another version is refused with `incompatible_version` until someone has read it the same way and
updated this package.

| What | How the 2.2.7 server does it |
| --- | --- |
| Where | Everything is under `/api`. Any other path gets the web page, with status 200: a health check that only looks at the status code passes on a page. There is no `/api/health`. |
| Health and version | `GET /api/info` answers `{ version, pid, hostname, urls, paths, capabilities }`. |
| Credentials | `OPENCODE_PASSWORD` on the server; the client sends `opencode:<password>` as Basic auth. Wrong or missing: `401 {"_tag":"UnauthorizedError","message":"Authentication required"}`. |
| Project | `x-opencode-directory: <canonical root>` on every request. A new session is bound to that directory. |
| Sessions together | `GET /api/session` lists sessions of **every** directory, whatever the header says. The `location.directory` of a session is what tells projects apart. |
| Create | `POST /api/session` `{ title }` answers `200 { data: session }`. |
| Read | `GET /api/session/:id` answers `{ data: session }`; an id that is well formed but unknown is `404 {"_tag":"SessionNotFoundError"}`, a malformed id `400 {"_tag":"InvalidRequestError","kind":"Params"}`. |
| Prompt | `POST /api/session/:id/prompt` `{ text, agent?, model? }` answers at once with the user's message: `{ data: { id: "msg_…", sessionID, type: "user", payload: { text }, delivery: "steer" } }`. The work is queued; the model's answer is not in this answer. |
| Messages | `GET /api/session/:id/message` answers `{ data: [{ id, time, text, type }], cursor }`. Only the first page is read. |
| Stop | `POST /api/session/:id/interrupt` answers `{ interrupted }`. |
| Events | `GET /api/event` is `text/event-stream`: `data: {"id":"evt_…","type":"server.connected","data":{}}`, then `: heartbeat` lines and events such as `session.created`, `session.inbox.enqueued`, `session.execution.started`. |
| Remove | `DELETE /api/session/:id` answers `204`. Not used by the Workbench. |

## What the adapter does with it

- One adapter belongs to one project directory. It never gives out, writes to or stops a session whose
  `location.directory` is another one, and it refuses a session the server binds elsewhere.
- The server address has to be an origin. One that is not on this machine has to be `https`, because the password
  travels with every request.
- Every failure is one `OpenCodeError` with a stable `kind`: `unavailable`, `timeout`, `unauthorized`,
  `incompatible_version`, `not_found`, `invalid_request`, `refused`, `protocol`.

## Not done here

- Permissions. A session that wants to edit or run something asks through `permission` events and
  `/api/session/:id/permission/:requestId/reply`. The adapter does not answer them; the Workbench has to decide who
  does, and a read-only task must not be given more than read tools.
- A model's answer. The smoke test queues a prompt and reads the user's message back. No model is configured in the
  isolated server it starts, so the answer is not part of what it checks.
- Managing a server process. Recording its pid, working directory and sessions is the next step; `info().pid` and
  the session's `directory` are what it will be checked against.
