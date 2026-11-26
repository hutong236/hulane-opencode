### WB-010 checkpoint — 2026-11-26: the server records and the API, and a correction about the model

- Task: the third part of Issue #14. Keep a record of each project's OpenCode server, and start, attach to, ask about and stop one through the API. No session route and no page yet.
- Branch: `feat/opencode-adapter`, Draft pull request #76, the commits after `fe657a6`.
- Files: `workbench/packages/database/src/{opencode-servers.ts,schema.ts,storage.ts,index.ts}` (migration 5 `opencode_servers`), `workbench/packages/database/test/{opencode-servers.spec.ts,project-remote-url.spec.ts}`, `workbench/apps/api/src/{opencode.ts,app.ts,server.ts}`, `workbench/apps/api/test/opencode-servers.spec.ts`, `workbench/packages/opencode-adapter/{src/client.ts,src/managed-server.ts,src/index.ts,README.md,test/*}`, `workbench/apps/api/package.json`, `workbench/package.json`, `workbench/package-lock.json`.
- Records. One `opencode_servers` row per project, replaced by its next server under the same id: kind (`managed` or `attached`), the registered root, the address, the pid, what `ps` said of the process when it was started, the Workbench process that started it, the version, a state and whether the read-only agent is proven. No password is stored anywhere. States after `running`: `stopped`, `exited`, `orphaned` (there and not proved to be the recorded process), `detached` (somebody else's server, let go of), then every way starting or reaching one fails.
- API. `POST /api/projects/:id/opencode/server` with `{ mode: "managed" }` starts one in the registered root and answers 201 with the record; with `{ mode: "attached", baseUrl, password? }` it attaches to one. `GET` the same path answers `{ server, held }`, where `held` says whether this Workbench process can stop it and give it a task. `DELETE` stops a managed one, lets go of an attached one, and ends a server an earlier run left behind only when the system says it is that process; one it cannot prove answers 409 with its pid and is left alone. A start that fails is kept as what it was (`not_installed`, `timeout`, `incompatible_version`, `readonly_agent`, …), so a page can say why. A repository that is gone is 409, as its status route is; the other failures are 503 with a reason. What a failed server printed goes to the log and is never sent.
- With the Workbench ending. `server.ts` answers SIGINT and SIGTERM by ending every server it started, noting `stopped`, and going with code 0; a server it was attached to is let go of. At its start it looks once at what an earlier run left: a managed server of a process that is gone is ended when proved, `exited` when its process is gone and `orphaned` when it is there and cannot be proved; one another Workbench process is still running is left alone; a server that was attached to is `unauthorized` until it is attached to again. Unregistering a project ends its server first.
- CI of the commits before this one (`fe657a6`, [run 45762406845](https://github.com/hutong236/hulane-opencode/actions/runs/45762406845)): 16 of 16 checks succeeded, and the job log shows both real cases running and passing on the Linux x86_64 runner, with only the guard for another installed version skipped.
- **A correction.** The entry below says that the isolated servers have no model and that a prompt is only queued. That was wrong, and so were the README and the commit message of `12bd463`. OpenCode 2.2.7 comes with a public provider, `opencode`, and one model, `big-pickle`, at `opencode.ai/inference`, with the API key `public` and a price of 0. So every run of the real smoke test sent one prompt to that public model, with the default agent `build`, which may edit and run commands, in an empty temporary repository, cut short when the test stopped its server a moment later: by my estimate about a hundred runs on this machine (I did not count exactly) and 2 on CI. No key of the developer's was used and nothing was charged. The isolation covered the four XDG directories and not `HOME`: a lab server loaded a skill from the developer's `~/.claude/skills`. The real tests send no prompt now, except the one that `WORKBENCH_REAL_MODEL_TEST=1` asks for, and their servers have a `HOME` of their own.
- Read from the real server since, with no prompt or with the read-only agent. **The agent is a property of the session**: `POST /api/session/:id/agent { agent }` answers 204 and the session has that `agent`. A new session has none and runs `build`. **The `agent` field of a prompt does nothing**: a prompt sent with `agent: "workbench-readonly"` was run by `build`. The switch takes any name, and a task for an agent that is not there fails with `session.execution.failed`. A run ends with `session.execution.succeeded`, `.failed` or `.interrupted`. The message list is the newest first; an assistant message keeps its answer in `content` parts, and there are `idle` and `agent-switched` messages. Reading `.env` asks first: the event `permission.asked`, then `GET /api/session/:id/permission`, and `POST /api/session/:id/permission/:requestID/reply { decision: "reject" }` answers 204. `GET /api/session/:id/diff` lists the files a turn changed. There is a route, `/api/session/:id/shell`, that runs a shell command in the project; the Workbench never calls it.
- The adapter follows. A prompt carries its text and nothing else. `setSessionAgent` switches the agent and gives the session out only when the server, read back, says the session runs it. `listSessions` gives the project's sessions. `endLeftoverServer` ends a left-behind server only when its number, its start time and its command line are the recorded ones.
- Read on the public model (opt-in, three tasks, with the session switched to `workbench-readonly`). Asked for the first line of `README.md`, it called `read` three times and answered the line; every stored answer is attributed to `workbench-readonly`. Asked to create a file, it called no tool, said it had none for that, and `/diff` stayed empty. Asked to print `.env`, it asked first; `reject` ended that, and the file's content is in no message. The opt-in test was run seven times while it was being written: 12 prompts to the public model in all.
- Validation (macOS arm64, Node 24.3.0, OpenCode 2.2.7): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 7 + 51 + 47 + 57 + 35, with 2 skipped on purpose in the adapter (the version guard and the opt-in model test). The API file has 12 cases against the fake program and the real CLI; one of them starts the real `server.ts` as a process, starts a server through it, sends SIGTERM and reads the database afterwards. The full browser suite passed 60/60 with `--retries=0`. Root `npm test` passed 208/208. 90 deliberate breakages are each caught: 51 of the adapter, 30 of the API, 9 of the records.
- Found by the tests, in the source: a status look that began before a server ended wrote `unavailable` over the `exited` that the ending had noted; a look wrote a note when nothing had changed; and the servers were not ended before the database closed, which only the test that runs the real server process showed, because the other tests hand the application a database of their own. A server that was unreachable and then ended stayed `unavailable`.
- Found on the way, in the tests: a failing `assert.ok` without a message makes Node read the test file back to name the expression, which on a file of five hundred lines took minutes. Every `assert.ok` in these files has a message now. Three API breakages hung the suite before that was found, and two more did because a server a failing case left running keeps the test process alive through its pipes; the fake marks its process and the tests sweep the marks.
- Not in this checkpoint. The session API bound to registered projects; the messages of a conversation (`getMessages` reads the user's own messages and no assistant's); answering a permission request through the Workbench; the page; Windows.
- Next: the session API, with the agent switched and read back before any task, then the page. Issues #14 and #3 stay open; no merge, Gate bypass or production claim.
### WB-010 checkpoint — 2026-11-26: a server the Workbench starts, and the read-only agent

- Task: the second part of Issue #14. Start an OpenCode server for a registered project from the Workbench, record its process, stop it, and make sure that only an agent proven read-only gets a task. All of it is in the adapter package: no API and no page yet.
- Branch: `feat/opencode-adapter`, Draft pull request #76, after `main` `4469611` (the merge of #74) was merged into it at `8c0601e`.
- Files: `workbench/packages/opencode-adapter/src/{managed-server.ts,readonly-agent.ts,client.ts,errors.ts,index.ts}` and `README.md`; `test/{mock-server.mjs,mock-server.d.mts,fake-opencode.mjs,managed-server.spec.ts,readonly-agent.spec.ts,rules.ts,client.spec.ts,real-server.spec.ts}`. `test/mock-server.ts` is `mock-server.mjs` now: plain JavaScript, so that the fake server can be run as a program without a loader. `.github/workflows/workbench-ci.yml` installs the pinned CLI on its Node 22 leg.
- Read from the real server, new in this checkpoint. `opencode serve --hostname 127.0.0.1 --port 0` picks a free port and prints `server listening on http://127.0.0.1:<port>`. Started without `OPENCODE_PASSWORD` it makes one and prints it. SIGTERM ended it in 66 ms. Starting it, creating a session and queueing a prompt wrote nothing into the project; everything went to the XDG data directory, so a session is still there for the next server. `x-opencode-directory` also selects that directory's configuration. The agents of a directory are loaded when the directory is first listed; until then a lookup by name is `404 AgentNotFoundError`, and the first listing can answer `[]` while the agent is found by name all the same. `GET /api/agent/:id` gives the rules the server computed: an ordered list where the last match wins, the server's rules first and the agent's after them.
- The read-only agent, `workbench-readonly`. The built-in `plan` agent calls itself read-only and leaves `shell` allowed, so it is not used. A managed server gets its own agent through `OPENCODE_CONFIG_CONTENT`, so nothing is written into a repository or into the user's configuration. The agent denies everything, then allows `read`, `glob` and `list`; `read` carries its own patterns so that `.env` files ask first, as they do for every agent (a flat `read: "allow"` undoes that). `grep` is not given: in the binary it runs ripgrep with `--hidden`. After a start the rules are read back from the server and resolved one by one, so a rule that was not applied, or one the user's own configuration put after the agent's, is seen.
- The managed server. It is started in the project directory with a password made for it that is never stored or printed, and given out only after: it printed where it listens and that is this machine under the address it was asked for; `GET /api/info` answers the verified version; the pid it reports is the pid of the process that was started; its read-only agent is there and is proven. `stop()` sends SIGTERM and, after 5 s, SIGKILL. Of the process are kept its pid, its directory, when it was started and what `ps` said about it then (start time, command line, parent). `connectOpenCode` attaches to a server someone else started and reads nothing into it; it is read-only for the Workbench only if it already has the agent.
- Validation (local macOS arm64, Node 24.3.0, OpenCode 2.2.7): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` in the package passed 32 and skipped 1 on purpose, in about 10 s: 10 of the client, 5 of the stream parser, 3 of the agent rules, 12 of the managed server against the fake program, and 2 against real servers started by the test with their own data directories. The real ones compare the rules the real server computed for the read-only agent with one fixed line, show `plan` as not read-only, start a second server on the same data and find the session of the first. The other packages passed 7 + 39 + 47 + 52; root `npm test` passed 208/208. 45 deliberate breakages, 25 of the managed server and 20 of the agent and client code, are each caught.
- Found on the way. The real test failed at first against the real server: its hidden agents `compaction`, `title` and `summary` come without a description, which the reader required. A server that printed where it listens in a form the adapter did not expect was waited for until the start timeout; it is refused at once now. Five of the breakages were not caught at first, each a gap in the tests and none in the source: two left a server running when a start that was expected to fail did not, and so hung the suite; one sits in a branch only a directory vanishing between two checks can reach, which has a case now; one passed because an assertion took an error of the right kind with the wrong cause, and asserted its message from then on; one was a real server that was killed and never asked to end.
- Not in this checkpoint. The Workbench CI never had the CLI, so its real cases were skipped there; the workflow installs it now, and the Linux result is not in yet. A model's answer is still not read. Nobody answers a permission request, and the read-only agent asks before it reads a `.env` file. A server left behind when the Workbench is killed is not looked for yet. Windows was not read. The service record table is written but not committed with this; the API is not written yet.
- Next: the service records and the API for starting, attaching to, asking about and stopping a server, then the session API bound to registered projects, then the page. Issue #14 and Issue #3 stay open; no merge, Gate bypass or production claim.
### WB-010 checkpoint — 2026-11-26: the adapter's contract with OpenCode 2.2.7

- Task: the first part of Issue #14. `workbench/packages/opencode-adapter` was a name and nothing else. This checkpoint reads a real OpenCode 2.2.7 server and builds the adapter on what it answers.
- Branch: `feat/opencode-adapter`, from `main` `48c33157278d15ab8b747ad585b788a07668e750`.
- Read from the real server, started from the installed CLI in a temporary repository: everything is under `/api`; there is no `/api/health`; any other path gets the web page with status 200. `GET /api/info` answers version, pid and hostname. The password goes as Basic auth and a wrong one is `401 {"_tag":"UnauthorizedError"}`. A session is bound to the `x-opencode-directory` of the request, and `GET /api/session` lists the sessions of every directory together. A prompt is queued: the answer is the user's own message, and the model's answer comes through the events. An unknown session is `404 {"_tag":"SessionNotFoundError"}`. The table is in the README of the package.
- The package: `OpenCodeAdapter` (info, createSession, getSession, sendPrompt, getMessages, subscribeEvents, abort) and `OpenCodeHttpAdapter`. One adapter belongs to one project directory: it never gives out, writes to or stops a session of another directory, and refuses a session the server binds elsewhere. The server address has to be an origin, and one on another machine has to be https. Every failure is one `OpenCodeError` with a stable kind.
- Validation (local macOS arm64, Node 24.3.0, OpenCode 2.2.7): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 7 + 36 + 41 + 29 in the other packages and 15 in this one, 14 of them and one skipped on purpose. Root `npm test` passed 208/208. 8 cases run against a mock server that repeats what the real one answered; 5 run the stream parser; 2 run against a real server started by the test with its own data, config and state directories, in about 0.8 s. The skipped one is a guard for a machine where another OpenCode version is installed. On CI there is no CLI, so the real cases are skipped there and the mock cases run. 20 deliberate breakages are each caught.
- Found by the tests: a stream stopped by the caller failed with an AbortError instead of ending; a web page given in place of the event stream was taken for a quiet server; a refused connection came out as a raw `fetch failed`; a bare 5xx from a proxy was reported as an unreadable answer instead of a refused one. All four are fixed and have their case.
- Not in this checkpoint: permissions (a session that wants to edit or run something asks through `permission` events; nobody answers them yet); the model's answer (the isolated server has no model configured); managing a server process; the API and the page. The message list reads its first page.
- Found on the way: the health check of the root CI job asks `/global/health` with `curl -f`, which passes on the web page the server returns for that path. My first probe listed the developer's own sessions: 26, read-only, and nothing was created or changed. Every server after that ran with its own data directories.
- Next: a server the Workbench starts and stops, recording pid, directory and sessions; then the API bound to registered projects, then the page. Issues #14 and #3 stay open; no merge, Gate bypass or production claim.
### WB-006 checkpoint — 2026-11-25: version selection and the diff view

- Task: the third and last part of Issue #10. On the requirements page, choose two versions, see what changed, and come back to a comparison that was stored.
- Branch: `feat/requirement-diff`, third commit, Draft pull request #74.
- Files: `workbench/apps/web/src/api/client.ts` (the diff contract with strict decoders, three requests), `workbench/apps/web/src/components/{RequirementDiffView.tsx,requirement-diff-text.ts,Requirements.tsx}`, `workbench/apps/web/test/{requirements-diff-client.spec.ts,requirement-diff-text.spec.ts}`, `workbench/e2e/{requirements-diff.spec.ts,real-requirements.spec.ts,requirements.spec.ts}`, `docs/SESSION_HANDOFF.md`.
- The page: the version history of a requirement has two lists, 基准版本 and 目标版本, with the version before the current one against the current one already chosen. 比较版本 sends the pair and shows the comparison: `V2 → V3`, the hash of the stored comparison, and five counts. Every change says where it is in words (`验收条目 AC-2 / 内容`, not only the pointer) and shows what was stored: a modification its old and new value, a question both sides with the reason and the entries it cannot be told apart from. What did not change is one button away. With one version the lists and the button are off and the page says why. The comparisons stored for the requirement are listed below and open from there.
- The client refuses what it cannot trust: a summary that disagrees with its entries, an addition without a value, a question without a reason, a hash that is not one, a comparison that names other snapshots than its record, a version compared with itself, and a record of another requirement given as an answer.
- Validation (local macOS arm64, Node 24.3.0, Chrome 158): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 7 lint + 39 API + 47 web + 52 database; root `npm test` 208/208. The full browser suite passed 60/60 with `--retries=0` in 4 of 4 runs: 8 cases against a mocked API (every kind of change with its values, unchanged folded away, a stored comparison reopened without comparing again, a comparison just made listed, one version, another version chosen and the same version refused, a refused comparison that keeps the selection and can be retried, markup in a value shown as text) and one against the real API: V3 and V4 of the requirement of the other cases are compared through the page, the title is the one change, and the counts and the hash on the page equal the comparison read back from the API. 14 deliberate breakages, 7 of the client and 7 of the page, are each caught.
- Found on the way: AntD keeps a hidden copy of every option for assistive technology, so a click has to take the option a person sees, and from the list that belongs to that select, because a list that has just closed is still on the page while it fades out; the full suite with five workers showed it, a single file did not. Two versions in the lists made `getByText('V3')` match twice in three older cases; they look in the versions table now. The count of questions was hidden when it was zero while the other zero counts were shown; all five counts are shown.
- Not verified: the comparison of two versions with 60,000 items is measured at the engine only; the page was not opened on a comparison that large. Real OpenCode CLI was not exercised; this checkpoint has no OpenCode part.
- The push that GitHub did not process: the third commit `cff14a46` reached GitHub on 2026-11-25 at about 15:47 UTC, while GitHub was degraded (pull requests, actions and webhooks were reported as `degraded_performance`; the network of this machine had been down for six minutes before that). The branch on GitHub moved to the commit, but the event that updates the pull request and starts CI was never processed: seven hours later the pull request still showed the second commit and no check had run for the third. A pull request merged in that state would have merged the second commit only, so `--match-head-commit` with the third would have refused it. This fourth commit changes this note only; it advances the branch so that GitHub processes a push again.
- Next: nothing pending for this Issue; its acceptance boxes wait for the human. Issues #10 and #3 stay open; no merge, Gate bypass or production claim.

### WB-006 checkpoint — 2026-11-25: a comparison is stored and offered over the API

- Task: the second part of Issue #10. Keep the result of a comparison in `requirement_diffs` with the ids of the two versions and its hash, and offer it over the API. No schema change: the table has been there since the first migration and was not used until now.
- Branch: `feat/requirement-diff`, second commit, Draft pull request #74.
- Files: `workbench/packages/database/src/{requirement-diffs.ts,storage.ts,index.ts}`, `workbench/apps/api/src/requirements.ts`, `workbench/packages/database/test/requirement-diffs.spec.ts`, `workbench/apps/api/test/requirement-diffs.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Storage: `RequirementDiffRepository.create(id, baseVersion, targetVersion)` reads both versions under that requirement, runs the engine and stores the canonical text with its SHA-256. A version never changes, so the same pair is stored once: the first call answers `created: true`, a later one gives the stored row back. A stored row is given back only after three checks on every read: its text hashes to its hash, it has the shape of a diff of this engine, and it names the two versions it is stored under. A row that fails one is refused with an error, never shown as a result. `list` gives the comparisons of one requirement, the newest first, without the changes; `find` gives one with its changes, and only under the requirement it belongs to.
- API: `POST /api/requirements/:id/diffs` with `{ baseVersion, targetVersion }` answers 201 for a new comparison and 200 with the stored one. `GET /api/requirements/:id/diffs` answers `{ diffs }`. `GET /api/requirements/:id/diffs/:diffId` answers one. A bad id or body is 400, an unknown requirement, version or comparison is 404, and a comparison of one requirement is not found under another.
- Validation (local macOS arm64, Node 24.3.0): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 7 lint + 39 API + 41 web + 52 database; root `npm test` passed 208/208. The storage file has 5 cases and the API file 3: computed from the two versions and stored once; the stored text and its hash, untouched by later versions and a restore; every refused input with its kind of mistake; a stored row that was changed, one that is not a diff, and a genuine diff of another pair put under the row; a comparison that has to be asked about; and the stored result compared with what the engine says for the snapshots the versions route returns. The two files passed in 30 and 15 repeated runs. 15 deliberate breakages, 11 of the storage and 4 of the routes, are each caught.
- Found on the way: the list was ordered by `created_at` and then by id. Two comparisons made in the same millisecond share the time, so their order fell to random ids. The order is the insertion order of the rows now.
- Not in this checkpoint: no page selects two versions or shows a comparison yet.
- Next: the version selection and the diff view on the requirements page. Issues #10 and #3 stay open; no merge, Gate bypass or production claim.

### WB-006 checkpoint — 2026-11-25: the diff engine

- Task: the first part of Issue #10, a deterministic comparison of two requirement snapshots. It is an algorithm and nothing else: no model is asked and nothing is matched by guesswork.
- Branch: `feat/requirement-diff`, from `main` `48c33157278d15ab8b747ad585b788a07668e750`. The branch name does not match `feat/WB-006-…` on purpose, so the autonomous workflow waits on the pull request instead of repairing it.
- Files: `workbench/packages/database/src/{requirement-diff.ts,index.ts}`, `workbench/packages/database/test/requirement-diff.spec.ts`, `docs/SESSION_HANDOFF.md`. The engine imports nothing but `node:crypto`.
- Result: `{ schema, base_sha256, target_sha256, summary, changes, unchanged }`. Every change carries a pointer and, for a modification, the old and the new value. Pointers follow JSON Pointer, with `/list[id=AC-2]/text` for the field of an item and `/tags[="prod"]` for a plain value of a list, because an index would move with every reorder.
- The rules: objects compare key by key and the order of keys never matters. An array whose every item is an object with a non-empty text `id` compares item by item, whatever the order; a kept id compares field by field, its own `id` aside. A list of plain values compares by counts. Any other array is one value. Two texts are equal when they differ only in Unicode normalization form or in line endings; leading and trailing spaces are a change, and missing, `null` and `""` are three values.
- What is asked about instead of decided, as `needs_review` with both sides shown: an id used more than once in a version (`duplicate_id`, with every copy, unless the copies are the same on both sides); an item that disappeared and an item with the same content and another id that appeared (`possible_rename`, or `ambiguous_match` when several are involved); a list of plain values whose values all remain but changed places (`reordered`); an array without stable ids that changed as a whole (`unkeyed_array_changed`).
- Validation (local macOS arm64, Node 24.3.0): the new file has 18 cases. Eleven are table-driven and cover each acceptance line of the Issue: a new `environment` field is `added` and a modified or a removed field shows its old and new value; a reordered list of items gives no change; the same input gives the same text and hash; nothing that cannot be matched is dropped. Two run on random inputs with a fixed seed, 2000 pairs and 1000 pairs of keyed lists: every leaf of both versions is accounted for exactly once, the result is the same when run again or when object keys are in another order, reversing the two versions swaps addition and deletion, a value never differs from itself, and changes and unchanged pointers are in pointer order. Four are stress cases: 60,000 items with 10,000 modified, 5,000 added and 5,000 removed in about 0.2 s; one id used 5,000 times gives one report; 50,000 equal plain values and a text of 200,000 characters; nesting 300 deep. One pins the text and the SHA-256 of a fixed diff, so a change of format has to be a deliberate decision.
- Mutation: 16 deliberate breakages of the engine are each caught. The last one, the unchanged pointers left unsorted, was not caught at first: no key in the test data could put the build order and the pointer order at variance. A key pair like `a` and `a!` does, and the order is now checked on every random pair too.
- Found while writing it: a value with a duplicated id differed from itself, because the duplicate was reported before the two versions were compared; the copies are compared first now. The `id` of a matched item was listed as an unchanged field for every modified item, which turned 45,000 unchanged items into 55,000; it is the item's address and is left out.
- Not in this checkpoint: nothing stores a diff and no route or page shows one. The requirement content of today has seven fixed fields, so the `environment` case is covered at the engine; the engine takes any JSON, so a field added to the content later is compared without further change.
- Next: store a diff in `requirement_diffs` with the two version ids and its hash, offer it over the API, then the version selection and the diff view on the page. Issues #10 and #3 stay open; no merge, Gate bypass or production claim.
### Workbench autonomous development — 2026-11-26: a mention is not a delivery

- Task: a defect in the guard that #71 added. It took a task code anywhere in a merged pull request, title or body, for the delivery of that task. On the real repository it held seven open tasks, WB-007, WB-010, WB-012, WB-013, WB-014, WB-024 and WB-028, because #68, #38, #34 and #35 quote those codes in their text or span them in a title. WB-010 was ready and P0, and the selector passed over it for WB-021, a P1 task. Found while checking why the selector chose WB-021.
- Branch: `fix/autodev-delivery-by-title`, from `main` `48c33157278d15ab8b747ad585b788a07668e750`.
- Rule now: a merged pull request delivers the task that its title names first, as in `WB-005: …` or `feat(workbench): WB-004 remaining scope …`. A task quoted in the text of another task's pull request is a mention. A title that spans several tasks, like `推进 WB-001～WB-028`, names WB-001 and no other. A pull request closed without merging delivers nothing.
- Evidence: on the 42 merged pull requests the old rule held seven open tasks and the new rule none. The titles that carry a code at all are the deliveries of WB-001 to WB-005, which are closed. Against the live API the selector answered `Selected WB-021` before and `Selected WB-010` after; WB-006 still waits on pull request #74 and WB-007 is still blocked by WB-006.
- Files: `bin/workbench-autodev.mjs` (`taskOfTitle`, the delivery check), `test/workbench-autodev.test.mjs`, `docs/WORKBENCH_AUTODEV.md`, `docs/SESSION_HANDOFF.md`.
- Validation: root `npm test` passed 208/208 and `npm run check:syntax` passed. Six deliberate breakages are each caught: the guard removed; a mention in the text counted again; any task named in a title counted; a pull request closed without merging counted; a longer number or a code glued to a word read as a task; the last task named in a title read as its own. The test that had encoded the wrong rule, "a merged pull request that names the code anywhere counts as delivery", is rewritten with the three real cases.
- Convention, now written in `docs/WORKBENCH_AUTODEV.md`: the title of a delivery pull request names its task, and no other task before it.
- Also on this day: GitHub was degraded on 2026-11-25 after 15:00 UTC. The push of the third commit of #74 reached GitHub but its event was never processed, and one check run of the fourth commit finished with `success` while its status stayed `in_progress`. The fourth commit advanced the branch; the push run was started again for the stale status.
- Next: WB-010 is the task the selector takes when the workflow runs; whoever takes it first opens a pull request that names it in the title. Issue #3 stays open; this is development automation, not production acceptance.

### Workbench requirements center — 2026-11-25: the list, the detail and the version history

- Task: issue #72 — the requirement data layer and API landed with PR #67, but the requirements page was a navigation placeholder: status transitions and queries were only reachable through the API. This delivers the three pages and the safe Markdown rendering.
- Branch: `feat/requirements-ui`, from `main` `9a8637ee6858581c1b7902e6d870a6feec3122b7`.
- Files: `workbench/apps/web/src/api/client.ts` (requirement contract, strict decoders, writes), `workbench/apps/web/src/components/{markdown.ts,SafeMarkdown.tsx,Requirements.tsx}`, `workbench/apps/web/src/App.tsx` (route), `workbench/apps/web/test/{requirements-client.spec.ts,safe-markdown.spec.ts}`, `workbench/e2e/{requirements.spec.ts,real-requirements.spec.ts}`, `docs/SESSION_HANDOFF.md`.
- Behavior: the list shows key, title, status, priority, current version and update time; a requirement is created with its structured fields and acceptance criteria. The detail renders background, goal, scope and risk through `SafeMarkdown`, saves a revision (a new immutable version) and moves the status one step at a time (draft→reviewed→approved→archived) behind a confirmation. The history lists every snapshot with its content hash, shows one read-only, and restores an old version as a new draft. Every write carries an operator and a summary, and the revision the caller saw: a stale one is refused with 409 and the typed form stays open.
- Safe Markdown: `markdown.ts` parses a small subset (headings, lists, `**bold**`, `*italic*`, `` `code` ``) into typed data and `SafeMarkdown.tsx` renders React elements only. There is no HTML step anywhere — no `dangerouslySetInnerHTML` in the code — so `<script>` in a requirement is five characters of text. The browser case proves it: the sample shows as literal text, no element is created, and the payload never runs.
- Validation (local macOS arm64, Node 24.3.0, Chrome 158): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 7 lint + 36 API + 41 web + 29 database. The full browser suite passed 50/50 with `--retries=0` in 2 of 2 runs (41 previous cases + 9 new: 8 against a mocked API, 2 against the real API and the real database). 7 deliberate breakages are each caught: the decoder accepting an unknown status or duplicate criterion ids, a write without the revision, the renderer handing the source to HTML, the parser no longer keeping HTML literal, a restore naming the wrong version, and the page no longer demanding an operator.
- Found on the way: AntD puts a space between the two characters of a button like 刷新, so its accessible name is "刷 新" and a test looking for 刷新 finds nothing; the two-character buttons now carry an explicit `aria-label`. The version table overflowed a 720px modal and the summary column collapsed to zero width — both tables now use a fixed layout with horizontal scroll. A content hash identifies content, not a version: a restore copies the source, so the new version's hash equals the source's.
- Not verified: no run as root (the permission-sensitive cases elsewhere skip there), and the pages are covered in one browser on macOS only; CI runs the same suite on Linux. Real OpenCode CLI was not exercised; this checkpoint has no OpenCode part.
- Next: nothing pending; the issue #72 acceptance boxes wait for the human. Issue #3 stays open; no merge, Gate bypass or production claim.

### Workbench autonomous development — 2026-11-25: a delivered task waits for acceptance

- Task: after a delivery pull request is merged, its task issue stays open until a person accepts it — and the selector then treated the task as new work and implemented it again. Live right after the project catalog change landed: the selection answered "Selected WB-004: new on feat/WB-004-autodev" on the delivered task, and the next scheduled run would have burned a model pass on it and opened a redundant Draft pull request.
- Branch: `fix/autodev-delivered-task-waits`, from `main` `7ca554d6a65b329d1dda670c589decb9dd2b49ab`.
- Fix: a merged pull request whose title or body carries the task code marks the task as delivered; the selector then answers "delivered in PR #N, awaiting acceptance" instead of selecting it. The code in the title or body counts, exactly as it does when open pull requests are matched to a task. A pull request closed without merging delivers nothing. An open pull request for the task still decides on its own. The direction of the error is deliberate: waiting for a person is safe, implementing delivered work again is not.
- Validation: the selector against the live API answers "WB-004: delivered in PR #65, awaiting acceptance"; root `npm test` passed 208/208 (two tests more than before); removing the delivered check turns both new tests red.
- Note: the issues of delivered tasks stay open until a person accepts them, so the selector keeps waiting for those tasks. That is the intended behavior; acceptance is the human's call, and Issue #3 stays open as well.
- Next: nothing pending. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-005 repair checkpoint — 2026-11-25: duplicate-key conflicts never depend on a readable snapshot

- Task: repair the duplicate-creation path so a stored requirement key is always rejected as a conflict, even when that row has no readable version snapshot, and add the missing regressions for duplicate creation, letter-case variants and a second connection.
- Branch: the autonomous repair branch for WB-005; the remote branch head is the authoritative SHA. No commit SHA is claimed here.
- Files: `workbench/packages/database/src/requirements.ts`, `workbench/packages/database/test/requirements.spec.ts`, `workbench/apps/api/test/requirements.spec.ts`, `docs/SESSION_HANDOFF.md`. No production UI or client file changed.
- Cause and change: `RequirementRepository.create` used the snapshot join inside `findByKey` to detect duplicates, so a stored key without a joined version reached the SQLite UNIQUE constraint and could surface as HTTP 500 instead of the intended conflict. It now reads the authoritative `requirements.requirement_key` column. A rejected create still appends no version, and the API continues to answer 409 without SQLite text.
- New regressions: an orphaned requirement row (key present, `current_version` 0) is rejected with `RequirementConflictError` and adds no row or version; a second SQLite connection cannot create a duplicate and cannot overwrite the winner; the API rejects `REQ-012` and `req-012` after one create while the stored title, requirement count and version count stay unchanged.
- Validation: **not run** in this connector-only repair session. Lint, typecheck, build, unit tests, Playwright and the reported failing CI could not be executed or read here, and the reported failure could not be reproduced by source inspection. Do not treat this checkpoint as CI evidence; read the exact remote SHA's Actions runs.
- Known limits: the `/requirements` list/detail/history page, the Web API client, safe Markdown rendering and the XSS browser case are still missing. Only the forward transition path exists.
- Next: add strict requirement decoders to `workbench/apps/web/src/api/client.ts`, then the `/requirements` list/create/edit/history page with text-only Markdown rendering and Playwright cases for XSS input, stale-revision retention and draft→reviewed→approved. Issues #9 and #3 stay open.

### WB-005 checkpoint — 2026-11-24: requirement repository, immutable snapshots and CAS API

- Task: first bounded WB-005 slice — workbench-wide requirement persistence with draft→reviewed→approved transitions, revision compare-and-swap, append-only version snapshots and a read/history API. UI is deliberately not part of this step.
- Branch: created by the autonomous workflow from the verified `main`; the remote branch head is the authoritative SHA. No commit SHA is claimed here.
- Files: `workbench/packages/database/src/requirements.ts` (new), `workbench/packages/database/src/schema.ts` (migration 2), `workbench/packages/database/src/storage.ts`, `workbench/packages/database/src/index.ts`, `workbench/apps/api/src/requirements.ts` (new), `workbench/apps/api/src/app.ts`, `workbench/apps/api/test/requirements.spec.ts` (new), `workbench/packages/database/test/requirements.spec.ts` (new), `workbench/packages/database/test/database.spec.ts`, `docs/SESSION_HANDOFF.md`.
- What changed: `RequirementRepository` stores key/title/status/revision beside `content_json` and `content_sha256`; every create, edit and restore appends a version with actor, summary and timestamp. Migration 2 adds those two version columns and `BEFORE UPDATE`/`BEFORE DELETE` triggers so snapshots cannot be rewritten in place. Edits and transitions require the exact revision, reject stale callers without changing the winning row, allow only draft→reviewed→approved→archived, reject edits after approval, and expose `GET/POST /api/requirements`, `PUT /api/requirements/:id`, `POST /api/requirements/:id/transitions`, `POST /api/requirements/:id/restore`, `GET /api/requirements/:id/versions` and `GET /api/requirements/:id/versions/:version`. All responses are validated records; errors are generic 400/404/409 and do not leak SQLite text.
- Validation: **not run** in this connector-only session. Added database cases for V1/V2/V3, direct-SQL immutability, cross-connection CAS, the transition matrix, restore-to-draft, duplicate keys and input bounds, plus Fastify `inject` cases for CRUD, stale saves, illegal transitions, history, restore and malformed IDs/payloads. Existing database migration-count expectations were updated for migration 2. Typecheck, build, unit tests, lint and Playwright remain **unverified** until CI for the pushed SHA runs.
- Known limits: no `/requirements` list/detail/history UI, no Web API client decoder, no safe Markdown renderer or XSS browser case, and no diff endpoint; only the forward transition path is implemented. Migration 2 is forward-only as required by the existing migration guard.
- Next: add strict requirement decoders in `workbench/apps/web/src/api/client.ts`, then the `/requirements` list/create/edit/history page with text-only Markdown rendering and Playwright cases for XSS input, stale-revision conflict retention and the draft→reviewed→approved flow. Issue #9 and production Issue #3 stay open.
### Workbench browser tests — 2026-11-25: the run ends in order now, no orphan waits behind

- Task: the full browser suite passed 41/41 in every run, but the process sometimes needed minutes to end (173 s, 68 s, 76 s, 359 s after the last case in four runs of twenty). Every check reported green long before the process left.
- Branch: `fix/e2e-webserver-graceful-shutdown`, from `main` `c255c05585eecbd7353c0b4ef974d60561c97e46`.
- Cause: Playwright ends its web server and its browsers by killing the whole process group with SIGKILL. A child that is started in that very moment survives as an orphan — its parent becomes init — and keeps a pipe open, so Playwright waits for it. Caught in the act with the API child of `tsx watch` and with a browser helper whose parent had died; the orphans held a throwaway data directory only. The same stall happens on a tree without any other change of mine (the control runs), so it is not caused by the tag storage or by anything else in the Workbench code.
- Fix: `workbench/playwright.config.ts` gives the web server `gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 }`. The group gets a SIGTERM and five seconds to end in order; SIGKILL follows only if it does not. The dev server (`concurrently` with `tsx watch` and `vite`) stops on SIGTERM as a group: verified directly with five SIGTERM trials of the real API, including a keep-alive connection and a half-open request.
- Validation (local macOS arm64, Node v24.3.0, Chrome 158): the browser suite ran 12 times in a row with the option: 41/41 in every run, 27–68 s each, every run exited by itself. Without the option, three of twenty runs hung after the last case: one took 10.9 minutes before it left on its own, two were still alive after 173 s and 359 s and had to be stopped by hand. The slowest run with the option (68 s) took 1.1 minutes for the cases themselves under load; its teardown was 2 s. `npm run lint`, `npm run typecheck`, `npm run build` passed and `npm test` passed 206/206. Five SIGTERM trials of the real API, including a keep-alive connection and a half-open request, all exited.
- Not verified: Windows is not affected by the option (Playwright ignores it there) and is not exercised. The CI runner never showed the stall: 59 of the last 60 Workbench CI runs ended the browser step in under 60 s, so this change is for the local runs and for the one slow run in sixty.
- Next: nothing; the WB-004 scope is complete in pull request #65. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-25: reserve the capability and dependency tags

- Task: the last item of the Issue #8 scope, "预留项目能力/依赖标签". The storage and its rules are reserved now; WB-007 (#11) builds the matching rules and the page on top of it.
- Branch: `feat/project-rename`, fourth commit, Draft pull request #65.
- Files: `workbench/packages/database/src/{schema.ts,projects.ts,index.ts}`, `workbench/packages/database/test/{project-tags.spec.ts,project-remote-url.spec.ts}`, `workbench/apps/api/test/project-tags.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Migration 3 adds the table `project_tags(project_id, kind, value, created_at)`: `kind` is `capability` or `dependency`, the value is one token of at most 64 characters, and the row disappears with its project (`ON DELETE CASCADE`). The checksum of migration 3 is pinned like the ones before it, so a later edit of it is refused.
- The repository offers three methods: `tags(id)` reads both kinds, `updateTags(id, revision, tags)` replaces both at once and `taggedWith(kind, value)` finds the projects that carry a tag. A tag is trimmed, lower-cased and repeated tags collapse; a value with a space, a punctuation mark or more than 64 characters is refused with the position of the offender, never with its text. At most 64 distinct tags per kind.
- A tag change is a change to the project: it takes the revision the caller saw, refuses a stale one, and raises the revision. A rename and a tag change therefore cannot overwrite each other. Saving the tags that are already stored changes nothing at all.
- Validation (local macOS arm64, Node v24.3.0): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 5 lint + 31 API + 33 web + 22 database; the database suite passed in 5 of 5 runs. 15 deliberate breakages of the tag storage are each caught: the cascade removed, the revision not moved or not checked, tags keeping their case, any text accepted as a tag, the limit removed, old tags kept when tags are replaced, saving the stored tags treated as a change, an unknown project answered with empty tags, the kind ignored in a lookup, migration 3 edited by one space, the table no longer required, the table no longer case-insensitive.
- Found on the way: the full browser suite passed 41/41 in every run, but the process sometimes needed minutes to end. The cause is in the test harness, not in this change: Playwright ends the browser and the dev server by killing their process groups, and a grandchild that was started in that moment survives as an orphan (its parent becomes init) and keeps a pipe open, so Playwright keeps waiting for it. I saw it with the API child of `tsx watch` and with Chrome's helper processes. The control run makes it plain: on the previous commit, without this change, 2 of 12 runs had a teardown over 60 s (173 s and 68 s) and all 12 runs passed 41/41; with this change 2 of 8 runs had it (76 s and 359 s) and all 8 passed 41/41. The CI runner has never shown it: 59 of the last 60 Workbench CI runs ended the browser step in under 60 s. The orphans held a throwaway data directory only and were cleaned up. A fix would be a `gracefulShutdown` entry for the web server in `playwright.config.ts` or a web server without a file watcher; neither belongs to this checkpoint.
- Not verified: no route and no page read or write the tags yet, on purpose; the API cases only tie the storage to what the API already does (unregistering removes the tags, a rename and a tag change share the revision). The real OpenCode CLI was not exercised; this checkpoint has no OpenCode part.
- Next: the WB-004 scope is complete. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-25: access checks, a reason for every refused path, and reads that leave the repository alone

- Task: the Issue #8 scope lists the access permission check and a read-only directory. Before this commit every invalid path got the same answer, no test used a directory without write permission, and reading a status rewrote the user's `.git/index` (its digest changed after one read).
- Branch: `feat/project-rename`, third commit, Draft pull request #65.
- Files: `workbench/apps/api/src/{app.ts,repository-root.ts,repository-status.ts}`, `workbench/apps/api/test/{project-path-reasons.spec.ts,project-path-guards.spec.ts,repository-root.spec.ts,repository-status.spec.ts}`, `workbench/apps/web/src/api/client.ts`, `workbench/apps/web/test/project-registration.spec.ts`, `workbench/e2e/{project-registration.spec.ts,real-projects.spec.ts}`, `docs/SESSION_HANDOFF.md`.
- Behavior: `validateRepositoryRoot` refuses with one of six reasons: `not_absolute`, `missing`, `not_directory`, `symlink`, `unreadable`, `not_git_root`. `/api/projects/validate` and registration answer `400 { error, reason }`. The reason is a fixed word, never the path. `unreadable` is new: entering the directory and its `.git` needs read and execute permission, and nothing needs write permission, so a read-only repository registers. The Web client maps each reason to one sentence (目录不存在, 该目录不是 Git 仓库的根目录, 路径中包含符号链接，请使用真实路径, …) and shows the general message for any reason it does not know. `runGit` passes `--no-optional-locks`, so a status read leaves `.git/index` byte-identical.
- Validation (local macOS arm64, Node v24.3.0, Chrome 158): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 5 lint + 29 API + 33 web + 15 database. The full browser suite with `--retries=0` passed 41/41 in 3 of 3 runs; the two changed files passed another 7 times each with `--repeat-each=7`. Root `npm run check:syntax` passed and root `npm test` passed 205/205. Every run used a throwaway `WORKBENCH_DATA_DIR`; the real data directory was not touched.
- Mutation: nine deliberate breakages are each caught by the test that should catch it: `--no-optional-locks` removed; the readability check removed; every reason replaced by `not_git_root`; the symlink refusal removed; readability wrongly requiring write permission (API and browser); the client looking the reason up without `Object.hasOwn`, so `__proto__` is shown as `[object Object]` (unit and browser); a wrong sentence for one reason.
- Found on the way: my first version of the new browser case had one unreadable line with a nested template string; Playwright refused the whole file with a syntax error, so the three "runs" I logged at first tested nothing. I now read the summary line of each run before counting it. A read-only directory also has to be made writable again in `finally`, or the shared cleanup cannot remove the temp directory.
- Not verified: the permission cases run as a normal user only. They are skipped when `process.getuid()` is 0, and the Linux CI runner is a normal user. Real OpenCode CLI was not exercised; this checkpoint has no OpenCode part.
- Next: the capability and dependency tags, reserved as a table. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-25: record the default branch and the remote

- Task: the Issue #8 scope lists the default branch and the remote. Every project was stored with `main` and no remote at all.
- Branch: `feat/project-rename`, the one branch for the remaining WB-004 scope; this is its second commit.
- Files: `workbench/packages/database/src/{schema.ts,projects.ts}`, `workbench/packages/database/test/{database.spec.ts,project-remote-url.spec.ts}`, `workbench/apps/api/src/{app.ts,repository-metadata.ts,repository-status.ts}`, `workbench/apps/api/test/project-metadata.spec.ts`, `workbench/apps/web/src/api/client.ts`, `workbench/apps/web/src/components/ProjectList.tsx`, `workbench/apps/web/test/project-list-client.spec.ts`, the project specs under `workbench/e2e/`, `docs/SESSION_HANDOFF.md`.
- Behavior: registration reads Git once and stores where `origin` points (`refs/remotes/origin/HEAD`), else `main` or `master` when that branch exists, else the branch checked out, or `HEAD` when detached. It stores the `origin` URL without any user name or password, or null when there is no origin. Migration 2 adds the nullable `remote_url` column; a database from the previous release keeps its projects and gains the column at its next start. Registrations made before this are not rewritten: they keep `main` and no remote. On the page the repository cell shows the path over `origin: …` or `无远端`, each with the full value in a tooltip and in the cell's name for assistive technology.
- Validation (local macOS arm64, Node v24.3.0, Chrome 158): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 5 lint + 26 API + 32 web + 15 database. The full browser suite with `--retries=0` passed 39/39 in 3 of 3 runs, including the real case that registers a repository with an origin and checks the recorded remote and default branch. Repeated to expose flakes: the four project API spec files 40 times, the database suite 40 times, the API, web and root unit suites 15 times each, and three browser spec files 6 times, all without a failure. Breakage checks: 12 of 12 deliberate breakages are caught, among them storing the remote with its credentials, ignoring where origin points, skipping the conventional branches, running Git with the inherited environment or with the repository's fsmonitor and hooks, editing released migration 1 by one letter, and the page showing credentials or accepting a project without the remote field. CI for the pushed SHA is pending until observed.
- Found on the way: I edited released migration 1 by one letter (`approvals` became `approval`) and noticed only because I compared checksums straight after. A test now pins the checksum of every shipped migration, and that mistake fails 14 database tests. A new database test passed once and then failed in 21 of 30 runs: three rows created in the same millisecond share `created_at`, so the list order falls back to the random id. Its assertion no longer depends on order. Seven columns did not fit at 1280, so the path and its remote share one cell.
- Coordination: this commit and #67 both add schema migration 2. Whichever is merged second has to renumber its migration to 3 and adapt its tests.
- About the union merge driver: Git takes merge attributes from the branch being merged into, not from `main`. Merging `main` into this branch conflicted at the top of this file although `main` carries `.gitattributes`, because this branch did not have the file yet. The driver starts helping only once a branch itself contains it, and on GitHub it never helps. The conflict was resolved by hand by keeping the entries of both sides.
- Next: access checks and the read-only directory, then the capability and dependency tags. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-25: rename a registered project

- Task: add the missing update step of the project CRUD: rename the catalog entry from the Web page.
- Branch: `feat/project-rename`. The remaining WB-004 scope uses one branch and one Draft pull request with one commit per checkpoint. The branch name deliberately does not match `feat/WB-004-…`, so the autonomous development workflow treats the pull request as not its own and never repairs it; the pull request title carries WB-004, which keeps that workflow on other Issues.
- Files: `workbench/apps/api/src/app.ts`, `workbench/apps/api/test/project-rename.spec.ts`, `workbench/apps/web/src/api/client.ts`, `workbench/apps/web/test/project-rename.spec.ts`, `workbench/apps/web/src/components/ProjectList.tsx`, `workbench/e2e/project-rename.spec.ts`, `workbench/e2e/real-projects.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Behavior: `PATCH /api/projects/:id` takes `{ name, revision }`, stores the trimmed name (1–120 characters) and increments the revision. It answers 400 for a malformed ID, name or revision, 404 for an unknown project and 409 when the revision is not the current one, so a rename made from a stale list never overwrites a newer one. The repository is not touched. On the page each row has “重命名”. The dialog states that only the workbench name changes, starts from the current name, cannot be saved twice or dismissed while the request is pending, re-reads the list after a save, and stays open with the typed name and a sanitized reason after a failure.
- Validation (local macOS arm64, Node v24.3.0, Chrome 158): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 5 lint + 21 API + 30 web + 12 database. The full browser suite with `--retries=0` passed 36/36 in 3 of 3 runs, including the real case that renames a registered repository through the real API and checks that HEAD and working tree are unchanged and that the name and revision 2 survive an API restart. Breakage checks: 12 of 13 deliberate breakages are caught (API ignoring the revision, a stale revision reported as 404, the unknown project no longer told apart, no length limit, untrimmed name, UI sending revision 0, closing on failure, not re-reading the list, other actions left enabled, blank name accepted, client dropping the revision or exposing the server body). Not caught: removing the guard in `closeRename`, because the dialog's cancel button, close icon, mask and Escape are already disabled while a request is pending; it stays as defense in depth. CI for the pushed SHA is pending until observed.
- Found on the way: a form field in an AntD dialog has no accessible name unless the form has a `name`; the browser case caught it. `shell.spec.ts` is not mocked and makes the development API open its database in whatever data directory it was started with. On this machine a local check run without `WORKBENCH_DATA_DIR` therefore created an empty `~/Library/Application Support/hulane-workbench/workbench.sqlite` with 0 rows in every table; it was left in place for the owner to decide. A separate change will give servers started by Playwright a throwaway directory.
- Next: record the default branch and Remote, then access checks and the read-only directory. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-24: the 25 stacked pull requests are merged

- Task: merge the WB-004 stack, #39 to #63, into `main` at the owner's request.
- Result: all 25 are merged. `main` moved from `b908c34` (WB-003) to `37cf2734`. Its tree equals the tree of the former stack tip `4ef99e6b`, all 52 original commits are reachable from it, and the difference to the old `main` is the same 42 files, +2682 and -15, that were scanned for secrets before merging.
- How: #39 was squash-merged as `5173762` and its branch deleted. GitHub then closed #40, whose base that branch was, and #40 conflicted with `main` because the squash had replaced the commits of #39. The branch was recreated at its old commit to reopen #40, and `0851252` was pushed to `main`: a merge that changes no file and makes the original head of #39 an ancestor of `main`. From there #40 to #63 were merged in order with merge commits, each one checked for its state, its second parent and an identical tree. A rehearsal in a scratch clone had shown the same 24 merges conflict-free before anything was pushed. The merge script stopped by itself before merging #40 while GitHub still reported it as conflicting, so nothing was merged in that state.
- CI on `main`: Workbench CI passed on 22 of the 25 commits; the 3 failures are the known states of #39, #49 and #50, each repaired by the next commit. Hulane CI passed on 20; on 6 intermediate commits its macOS job was cancelled before any step ran while the other five jobs passed. The final head `37cf2734` passed both. This is development CI, not production acceptance.
- Not done: the remote branches were left in place, because the repository does not delete branches on merge and nobody asked for it. Hulane CI runs on push only for `main` and `feat/**`; for `fix/…`, `test/…` and `chore/…` branches it runs on pull requests only.
### Workbench autonomous development — 2026-11-25: the selection failed on every run after #68

- Task: the scheduled autonomous development workflow stopped working again, and the cause was mine. #68 read the list of the workflow runs with the helper that expects a plain list of rows, and the Actions API answers with an object that carries the rows under `workflow_runs`.
- Branch: `fix/autodev-wrapped-actions-response`, from `main` `a2f7f6dee46176303e7456888f8fbc7d1476bb6c`.
- Evidence: `node bin/workbench-autodev.mjs select` on `main` fails with "Unexpected GitHub response"; the same command on this branch answers "No safe task selected: WB-004: PR #65 is not a trusted task branch; WB-005: PR #67 awaiting review; WB-6: blocked by 5; …". The shape was read from the live API: `GET /repos/hutong236/hulane-opencode/actions/runs` answers HTTP 200 with an object `{total_count, workflow_runs}`, while the issues and pull request endpoints answer with a plain list.
- Why the test did not catch it: the tests of the selector cover its pure functions; the helper that reads the API was never driven, and the Actions endpoint was mocked with the wrong shape. `rowsOf` and `pages` are exported now, and a new test reads both shapes, the pagination over a full page and the refusal of an answer that is neither a list nor an object with rows.
- Validation: root `npm test` passed 206/206 (one test more than before) and `npm run check:syntax` passed. Removing the fix turns the new test red; with it, the selector answers correctly against the live API.
- The cadence of the schedule is not ours to decide: the cron says every 30 minutes, but the two scheduled workflows of this repository ran every 8 to 12 hours over the last four days (autonomous development: 2026-11-22 21:26, 11-23 01:51, 11-23 09:54, 11-23 21:47, 11-24 05:38, 11-24 16:35, 11-25 01:09; progress: 11-21 22:56, 11-22 02:56, 11-22 11:02, 11-22 18:37, 11-23 00:06, 11-23 08:02, 11-23 20:28, 11-24 04:56, 11-24 15:42, 11-25 00:28). The runs are created late, not late in the queue: `run_started_at` equals `created_at` in every one of them.
- Next: after this is merged the selection works again; the next scheduled run picks up the task that is ready. Issue #3 stays open; this is development automation, not production acceptance.

### Workbench autonomous development — 2026-11-24: first real publishing run, and a log file of its own

- Task: confirm that publishing works for real, correct a wrong statement about merging, and stop autonomous runs from editing the hand-written handoff.
- Branch: `fix/autodev-own-log-file`, from `main` `5ad8ef9a`. The remote branch head is the authoritative SHA.
- First real run with publishing: [45450862344](https://github.com/hutong236/hulane-opencode/actions/runs/45450862344), dispatched on `main` at 17:38 UTC. It selected WB-005, ran the model for 5 minutes, verified 10 files, passed every check on the runner with 27 browser cases, pushed `feat/WB-005-autodev` and opened Draft pull request [#67](https://github.com/hutong236/hulane-opencode/pull/67). The CI of #67 passed on all 16 checks, so the selector now leaves WB-005 alone until a person reviews it.
- Correction: #64 stated that `.gitattributes` with `merge=union` lets two branches that both prepend an entry to `SESSION_HANDOFF.md` merge without a conflict. That is true for a merge made with Git and false on GitHub: its pull request check ignores the driver and reported #65 as conflicting against the new `main`, while `git merge` of the same two versions was clean. This is a known limitation, [GitHub Community Discussion 9288](https://github.com/orgs/community/discussions/9288). `docs/WORKBENCH_AUTODEV.md` is corrected.
- Change: an autonomous run writes its checkpoint to `docs/WORKBENCH_AUTODEV_LOG.md`. The runner refuses an edit of `SESSION_HANDOFF.md` and the agent is not allowed to make one, so an autonomous pull request does not overlap a hand-made one at the top of that file. The union driver stays on both files because it makes a local `git merge main` clean.
- Files: `.github/workflows/workbench-autodev.yml`, `bin/workbench-autodev.mjs`, `test/workbench-autodev.test.mjs`, `test/workbench-autodev-workflow.test.mjs`, `.gitattributes`, `docs/WORKBENCH_AUTODEV.md`, `docs/WORKBENCH_AUTODEV_LOG.md`, `docs/SESSION_HANDOFF.md`.
- Two selector defects, found from the first scheduled run: [45523668638](https://github.com/hutong236/hulane-opencode/actions/runs/45523668638) at 01:09 UTC repaired #67 although its checks were green. The selector then counted any run of the pull request head that was not a success, and the push run of its first commit had the macOS job cancelled before any step ran. The verdict now looks at the latest run of each workflow and at every job in it, and a cancelled, missing or still running CI makes the selector wait instead of rewriting a green pull request. Separately, the dependency parser stopped at the end of the first line: WB-012 lists WB-002 and WB-010 and read as ready. It now reads every line of the section. The run added commit `3ba4f490` and a comment to #67 for nothing.
- Validation: `node --test test/workbench-autodev.test.mjs test/workbench-autodev-workflow.test.mjs` passed 18/18 and root `npm test` 205/205 locally. Ten deliberate breakages are each caught: the agent allowed to edit the handoff again, the log file without the union driver, the runner accepting an edit of the handoff, and seven around the verdict and the dependency parsing. Run read-only against the repository, the fixed selector answers "wait": WB-004 has #65, WB-005 has #67, and WB-006 to WB-012 are blocked by open dependencies. The new log file has not been written by a real autonomous run yet; the next scheduled run shows it.
- Known: #67 edits `SESSION_HANDOFF.md`. On GitHub it conflicts as soon as another change to the top of that file is merged; update it locally with `git merge main` and push. #67 and #65 both add schema migration 2, so whichever is merged second has to renumber its migration to 3 and adapt its tests.
- Next: watch the next scheduled run write into the log file, and review #67. Issue #3 stays open; this is development automation, not production acceptance.

### Workbench autonomous development — 2026-11-25: workflow completed and verified by dry runs

- Task: repair `.github/workflows/workbench-autodev.yml`, truncated since its first commit, and re-enable it at the owner's request.
- Branch: `fix/workbench-autodev-workflow-20261125`, pull request #64, from `main` `37cf2734`. The remote branch head is the authoritative SHA.
- Files: `.github/workflows/workbench-autodev.yml`, `bin/workbench-autodev.mjs`, `test/workbench-autodev.test.mjs`, `test/workbench-autodev-workflow.test.mjs`, `docs/WORKBENCH_AUTODEV.md`, `docs/SESSION_HANDOFF.md`.
- What changed: the missing stages now exist. A dedicated `autodev` agent may read and may edit `workbench/*` and `docs/SESSION_HANDOFF.md`, nothing else. The change verification also rejects deleted files and changes to existing test scripts or to tracked test configuration. A credential-free check step streams every result into the job log, and the publishing step runs only after every check passed and only opens or comments on a Draft pull request. A `workflow_dispatch` with `publish=false` runs everything and publishes nothing. The structure test reads the workflow at the start of every run. Details are in `docs/WORKBENCH_AUTODEV.md`.
- Validation: root `npm test` passed 199/199. 13 deliberate breakages of the workflow are all caught by the structure test, and the truncated file from `main` fails all 5 of its cases. The scripts were extracted from the YAML and executed locally: branch step 3/3, verification 16/16, publishing with a stubbed `gh` and a local bare origin 10/10, and the real check step 10/10 in 65 s, or a red run when lint is made to fail. Two real dry runs on GitHub with `publish=false`, [45441282096](https://github.com/hutong236/hulane-opencode/actions/runs/45441282096) and [45446363872](https://github.com/hutong236/hulane-opencode/actions/runs/45446363872), selected WB-005, ran the model for 11 and 7 minutes with `deepseek/deepseek-flash`, passed the verification and every check, and published nothing.
- Not verified yet: the publishing step against GitHub, that is the push with the dedicated token, the Draft creation and the repair comment. The first run that publishes shows whether it works.
- Coordination: WB-004 is reserved by pull request #65, so the selector starts with WB-005. Nobody reviews a change before it becomes a Draft pull request, and a red one is retried by every later run without a cap.
- Next: merge #64, watch the first run that publishes, and review the Draft pull request it creates. Issue #3 stays open; this is development automation, not production acceptance.

### WB-004 checkpoint — 2026-11-24: lint tests wired in, Playwright output ignored

- Task: make the Workbench lint unit tests run in CI, and stop Playwright's generated output from failing lint locally or being committed.
- Branch: `chore/WB-004-playwright-output-20261124` (Draft PR stacked on #62); parent: `f91b308f10bdd3baae107189e67bc10a18980f0f`. The remote branch head is the authoritative SHA.
- Files: `workbench/package.json`, `workbench/scripts/lint.mjs`, `workbench/test/lint.test.mjs`, `workbench/.gitignore`, `test/workbench-test-isolation.test.mjs`, `docs/SESSION_HANDOFF.md`. No product code changed.
- Cause: `workbench/test/` is not a workspace and the Workbench `npm test` only ran `npm run test --workspaces`, so no CI command ever executed the four lint cases that the WB-001 checkpoint recorded as coverage. Separately, `npm run lint` walked `test-results/` after any browser run and failed on Playwright's `.last-run.json`, and Git did not ignore that directory.
- Change: the Workbench `npm test` runs `test/*.test.mjs` before the workspaces; lint exports `lintDirectory()` and skips `test-results`, `playwright-report` and `blob-report`, which `.gitignore` now ignores; a new lint case covers the exclusion; the root regression asserts that the Workbench test script keeps running both parts, so the wiring cannot be dropped silently again.
- Validation (local macOS arm64, Node v24.3.0): Workbench `npm test` passed 5 lint + 18 API + 26 web + 12 database; `npm run lint` passed with all three output directories present and `git status` stayed clean; `npm run typecheck` and `npm run build` passed; the full browser suite with `--retries=0` passed 27/27; root `npm run check:syntax` and `npm test` passed 192/192. Breakage checks: removing `test-results` from the lint exclusions fails the new lint case; dropping `test/*.test.mjs` from the test script fails the root regression. CI for the pushed SHA is pending until observed.
- Parent CI: `f91b308f` Workbench CI [45425249350](https://github.com/hutong236/hulane-opencode/actions/runs/45425249350) (push) and [45425343528](https://github.com/hutong236/hulane-opencode/actions/runs/45425343528) (pull_request) passed 27 browser cases including the 4 real ones on Node 22; Hulane OpenCode CI [45425342615](https://github.com/hutong236/hulane-opencode/actions/runs/45425342615) (pull_request) passed 6/6.
- WB-004 state: the three Issue #8 acceptance criteria are covered by automated cases that pass in CI, but the Issue's implementation scope is not complete. Checked in code: there is no update route or UI although `ProjectRepository.updateName` exists; `default_branch` is always stored as `main`; no Remote, access permission or capability/dependency tag is recorded; the Issue's read-only directory scenario has no test. The WB-004 stack, from #39 to this PR, is unreviewed and unmerged.
- Next: read CI for this exact SHA; then add the project update route and UI, detect the default branch and Remote, and cover the read-only directory. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-24: real three-repository browser E2E

- Task: run the WB-004 flow end to end in CI with a real Fastify process, real Git repositories and the real page; nothing under `/api` is mocked.
- Branch: `test/WB-004-real-browser-e2e-20261124` (Draft PR stacked on #61); parent: `ffb0221083c5c0010a389b292a56e74e1deda7b3`. The remote branch head is the authoritative SHA.
- Files: `workbench/e2e/real-projects.spec.ts`, `docs/SESSION_HANDOFF.md`. No product code changed.
- How it runs: the spec starts the real API itself on a free port with its own SQLite directory below a canonical temp path, and points only the page's `/api` calls at it, so the shared development API and a developer's real registrations are never read or written. It belongs to `npm run test:e2e`, so the Workbench CI browser step runs it.
- Coverage (4 serial cases): (1) three real repositories are registered through the form — clean on `main`; staged, unstaged and untracked work on `feature/automation`; an unborn repository — and each row shows the HEAD prefix, live branch and dirty state that Git itself reports. (2) A plain directory, a symlink alias and a duplicate are refused with a reason, a relative path is refused by the form, and the registration count stays at 3. (3) Unregistering the dirty repository leaves its directory byte-identical and the other two registrations unchanged. (4) After the API process is stopped and started again, the two registrations persist and the unregistered files are still on disk.
- Validation (local macOS arm64, Node v24.3.0, Chrome 158): the 4 cases passed in 6 consecutive runs with `--retries=0`; the full browser suite passed 27/27 in 5 of 5 runs; `npm run lint`, `npm run typecheck`, `npm run build` and `npm test` passed. One run without an isolated data directory for the shared API left the default data directory nonexistent, as before, with no API process, temp directory or port left behind. Four deliberate product breakages are each caught through the browser: unregister removes the directory, registration accepts any absolute path, status always reports clean, status reports a hard-coded branch. CI for the pushed SHA is pending until observed.
- Learned while writing it, none from product code: `import.meta` in a spec makes Node reinterpret Playwright's CommonJS output as ESM (`require is not defined`); `config.rootDir` follows the command-line file filters, so the workbench root is taken from the configuration file's directory; a `/\/api\//` route pattern also captures the page's own `/src/api/client.ts` module.
- Scope gap noticed and not addressed: `default_branch` is stored as `main` for every project and no Remote is recorded, although the Issue #8 scope lists both. The branch shown in the table is read live from Git.
- Next: read CI for this exact SHA; then ignore Playwright output directories, and decide how to record the default branch and Remote. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-24: API test fixtures run on macOS

- Task: make the Workbench API test suite pass on macOS with its default temporary directory.
- Branch: `fix/WB-004-api-temp-root-20261124` (Draft PR stacked on #60); parent: `d5b11cd8900df87398104aa2bf1cb8c4cf1a094e`. The remote branch head is the authoritative SHA.
- Files: new `workbench/apps/api/test/fixture-prefix.ts`; the 12 spec files under `workbench/apps/api/test/` that created fixtures with `join(tmpdir(), …)`; `docs/SESSION_HANDOFF.md`. No product code changed.
- Cause: macOS places its default temp directory below `/var`, a symlink to `/private/var`. The repository and database path guards reject any symlinked path component, so fixtures created from the raw `tmpdir()` were refused: 15 of 17 cases failed at `ec9756c3`. CI never showed it because Ubuntu's `/tmp` is not a symlink.
- Change: `fixturePrefix(prefix)` returns the prefix below the resolved real temp path, and every API fixture now uses it, as the database package tests already did inline.
- Validation (local macOS arm64, Node v24.3.0, default `TMPDIR` below `/var/folders`): API tests 18/18, web 26/26, database 12/12; `npm run lint`, `npm run typecheck` and `npm run build` passed. With the symlink check removed from `repository-root.ts` as a deliberate breakage, `accepts canonical Git roots and rejects nested, non-Git and symlink paths` fails, so the portability change did not empty the symlink assertions. CI for the pushed SHA is pending until observed.
- Parent CI: `d5b11cd8` Workbench CI [45420146461](https://github.com/hutong236/hulane-opencode/actions/runs/45420146461) (push) and [45420221661](https://github.com/hutong236/hulane-opencode/actions/runs/45420221661) (pull_request); Hulane OpenCode CI [45420222009](https://github.com/hutong236/hulane-opencode/actions/runs/45420222009) (pull_request, 6/6). All completed with success and the new multi-repository case ran on Node 20 and 22.
- Next: read CI for this exact SHA; then add the real three-repository browser E2E. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-24: multi-repository unregister keeps files and other registrations

- Task: turn "unregister deletes no repository file" into an API regression that runs in CI against real Git repositories and SQLite.
- Branch: `test/WB-004-unregister-multi-repo-20261124` (Draft PR stacked on #59); parent: `7b1e256528200831740ee1b48ac8f2880d3c8733`. The remote branch head is the authoritative SHA.
- Files: `workbench/apps/api/test/project-unregister-isolation.spec.ts`, `docs/SESSION_HANDOFF.md`. No product code changed.
- Coverage: three real temporary repositories are registered through the real Fastify routes: clean with a second branch; dirty with an unstaged edit plus a staged and an untracked file; unborn with an untracked file. After each real status is read, a content digest of every file including `.git` is taken and the dirty one is unregistered. The case asserts an empty 204; identical digests for all three directories; the same staged, unstaged and untracked entries and refs; only `cmdb` and `monitoring` left with unchanged real status; 404 without local paths for the removed ID; and, after reopening the database, both registrations and the removal persist while the same directory registers again with a new ID.
- Validation (local macOS arm64, Node v24.3.0): the new case passes with the default macOS `TMPDIR` because it resolves the canonical temp root itself. `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 18 API + 26 web + 12 database with `TMPDIR` on a canonical path; with the default `TMPDIR` the other 15 API cases still fail as recorded below. The full Playwright suite with `--retries=0` passed 23/23. Five deliberate product breakages (unregister removes the directory, resets tracked and deletes untracked files, deletes untracked files only, removes the first project instead, clears every registration) each fail the new case. CI for the pushed SHA is pending until observed.
- Parent CI: `7b1e2565` Workbench CI [45418744549](https://github.com/hutong236/hulane-opencode/actions/runs/45418744549) (push) and [45418771186](https://github.com/hutong236/hulane-opencode/actions/runs/45418771186) (pull_request); Hulane OpenCode CI [45418771357](https://github.com/hutong236/hulane-opencode/actions/runs/45418771357) (pull_request). All completed with success and browser E2E passed 23/23 in both Workbench runs. No Hulane push run exists for that branch name because `ci.yml` runs on push only for `main` and `feat/**`.
- Next: read CI for this exact SHA; then make the remaining API tests pass on macOS, and add the real three-repository browser E2E. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-24: request-count browser fixtures made phase-driven

- Task: remove the dependence on React StrictMode's initial request count from three Playwright cases that failed intermittently.
- Branch: `fix/WB-004-strictmode-count-fixtures-20261124` (Draft PR stacked on #58); parent: `8e400373e8475cbd878043052ccc80ff71aea6b8`. The remote branch head is the authoritative SHA.
- Files: `workbench/e2e/project-health-isolation.spec.ts`, `workbench/e2e/project-list.spec.ts`, `docs/SESSION_HANDOFF.md`. No product code changed.
- Cause (measured): under StrictMode in development `ProjectHealth` and the list effect issue their request twice, but the first is aborted in the cleanup and reaches Playwright's route handler only sometimes. Over 30 repetitions the first row's status route received 2 initial requests 21 times and 1 request 9 times. Fixtures that answered "error until the third request" therefore served the error to the explicit retry in the 1-request case.
- Change: each mocked outage now ends when the test flips a flag after the error is visible and before clicking retry. The isolation case additionally asserts that retrying the failed row sends a new status request for that row and none for the healthy row.
- Validation (local macOS arm64, Node v24.3.0, Chrome 158): before the change the three cases failed 17 of 90 repetitions with `--retries=0` (HTTP 503 retry 9/30, health isolation 4/30, stale repository 4/30). After it they passed 180/180, and the full suite with `--retries=0` was 23/23 in 5 of 5 runs; 3 of the 9 runs before the fix had failed. `npm run lint` and `npm run typecheck` passed. Four deliberate product breakages (retry re-reads every row, status retry does not re-read, list retry does not reload, error not redacted) are each caught by the rewritten cases. CI for the pushed SHA is pending until observed.
- Parent CI: `8e400373` Workbench CI [45415019214](https://github.com/hutong236/hulane-opencode/actions/runs/45415019214) (push) and [45415182214](https://github.com/hutong236/hulane-opencode/actions/runs/45415182214) (pull_request); Hulane OpenCode CI [45415019105](https://github.com/hutong236/hulane-opencode/actions/runs/45415019105) (push, 6/6 after the macOS job waited about 10 minutes for a runner) and [45415182200](https://github.com/hutong236/hulane-opencode/actions/runs/45415182200) (pull_request) all completed with success. Workbench browser E2E passed 23/23 without using its retry.
- Next: read CI for this exact SHA; then add an API-level multi-repository unregister regression and the real three-repository browser E2E. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-24: unregister UI with explicit confirmation

- Task: wire the existing `unregisterProject` client into the registered-project table with a per-row action, an explicit confirmation, duplicate-submit blocking, list refresh after success and row retention after failure.
- Branch: `feat/WB-004-unregister-ui` (Draft PR stacked on #57); parent: `ec9756c3cd60faf1dba78dc76df318842711418b`, the remote head of `feat/WB-004-unregister-client-20261123` verified before the edit. The remote branch head is the authoritative SHA.
- Files: `workbench/apps/web/src/components/ProjectList.tsx`, `workbench/apps/web/src/components/UiPrimitives.tsx`, `workbench/e2e/project-unregister.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Behavior: “取消登记” opens a confirmation naming the project and repository directory and stating that local repository files, branches and uncommitted changes are not deleted (“保留登记” / “确认取消登记”). The confirmation stays open while the DELETE is pending; other rows and the refresh action are disabled meanwhile. Success re-reads the list. Failure keeps every row and shows `取消登记「<name>」失败` with the sanitized client message; nothing is retried without a new confirmation. Only the persisted UUID is sent.
- Acceptance: 7 Playwright cases — confirmation wording and keep-registered sends nothing; a 200-character name and 240-character path keep title, description and buttons inside a 1280×720 viewport; one UUID DELETE removes only that project and re-reads the list; a pending request keeps its confirmation open, blocks the other row and refresh, and is not sent twice; HTTP 500, HTTP 404 and a lost connection keep the project with a safe error until an explicit retry succeeds.
- Validation (local macOS arm64, Node v24.3.0, Chrome 158; CI uses Node 20/22 on Ubuntu): `npm run lint`, `npm run typecheck` and `npm run build` passed. `npm test` passed 17 API + 26 web + 12 database with `TMPDIR` on a canonical path. Root `npm run check:syntax` and `npm test` passed 192/192. Full Playwright suite with `--retries=0`, 9 runs: the 7 new cases passed in every run and the suite was 23/23 in six runs; the pre-existing `project-health-isolation.spec.ts:14` failed in three runs. One real-API run with three temporary Git repositories (clean; staged + unstaged + untracked changes; unborn) showed the same HEAD prefix, branch and dirty state as direct Git output; after unregister the directory was byte-identical across 49 entries including `.git`, the other two registrations were unchanged and survived a full API restart. Not run locally: real OpenCode CLI and this commit's GitHub Actions; read both from the CI results of the pushed SHA.
- Mutation check: 10 of 11 deliberate breakages of this change are caught by the new spec. Removing the synchronous `unregisterPending` guard is not observable because AntD already ignores a repeated confirm while the promise is pending; the guard stays as defense in depth and is not independently verified.
- Pre-existing gaps found, none introduced here: (1) API tests call `tmpdir()` directly, so 15 of 17 fail with the macOS default `TMPDIR` where `/var` is a symlink. (2) `project-health-isolation.spec.ts:14` and the stale-repository case in `project-list.spec.ts` answer by request count and assume two StrictMode initial status requests; the first failed in 3 of 9 local runs and the cause is not yet confirmed. (3) `workbench/test-results/` is neither ignored by Git nor excluded from `npm run lint`, so lint fails locally after one E2E run. (4) `.github/workflows/workbench-autodev.yml` on `main` stops at line 87 inside the model step, so scheduled runs such as [45334731550](https://github.com/hutong236/hulane-opencode/actions/runs/45334731550) end after step 9 and never test or publish.
- Next: read CI for this exact SHA and fix any failure first; then add an API-level multi-repository unregister regression and the real three-repository browser E2E. Issues #8 and #3 stay open; no merge, Gate bypass or production claim.

### WB-004 checkpoint — 2026-11-23: safe unregister Web API client

- Task: add strict persisted-UUID DELETE client with HTTP 204 empty-body handling, sanitized errors and abort propagation; add four Node regression cases.
- Branch: `feat/WB-004-unregister-client-20261123`; parent: `04b35e1d41e2cbe0d847fc50d1d3dae53fa8e524`; authoritative new SHA is the remote branch ref (not self-referenced here).
- Files: `workbench/apps/web/src/api/client.ts`, `workbench/apps/web/test/project-unregister.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: invalid IDs cause no request; successful DELETE returns void only on 204; server response body is never exposed; cancellation is preserved. This only unregisters the catalog entry, not repository files.
- Validation: static source review; Node tests, browser E2E, TypeScript and real OpenCode CLI **not run** in this connector-only run. New commit CI must be checked separately.
- Concurrency: repository-level Actions in_progress=0, queued=0, waiting=0, requested=0, pending=0 before isolated branch write; prior WB-004 commit `04b35e1d41e2cbe0d847fc50d1d3dae53fa8e524` Workbench/Hulane CI passed.
- Next: inspect this exact commit's CI; then implement ProjectList explicit confirmation, duplicate-submit guard, error retention, successful refresh and browser regression. Issues #8 and #3 stay open.

### WB-004 checkpoint — 2026-11-22: multi-project Git health isolation regression

- Task: add Playwright regression for two registered project rows, one 404 error and one healthy dirty repository; retry only the failed row.
- Branch: `test/WB-004-health-isolation-20261122`; parent: `8e0c54bffc4f6822a2be6e88e07872be7d1b10e8`; new remote SHA is authoritative at the branch ref.
- Files: `workbench/e2e/project-health-isolation.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: missing-project error is redacted, healthy project remains visible, failed project can recover independently, and no other row loses its status.
- Validation: source-level review only; local Playwright/TypeScript and real OpenCode CLI not run. This commit's Actions status must be checked separately.
- Concurrency: repository-level REST Actions reported in_progress=0 and queued=0 before isolated branch creation.
- Next: check this commit's Workbench and Hulane CI; fix failures first, then complete WB-004 unregister UI and real three-repository E2E. Issues #8 and #3 remain open.

### WB-004 checkpoint — 2026-11-22: per-project live Git health UI

- Task: render persisted-ID Git health in the registered-project table (short HEAD, live branch, dirty/clean), with isolated stale-repository error and retry.
- Branch: `feat/WB-004-project-health-ui-20261122`; parent: `5174952ef360a776f3a247ce782c5886d22c7c3a`; authoritative new SHA is the remote branch head.
- Files: `workbench/apps/web/src/components/ProjectList.tsx`, `workbench/e2e/project-list.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: each registered row queries only its UUID-based status endpoint; 409 errors are redacted, retry is per row, and pending requests abort on refresh/unmount.
- Validation: source-level inspection only. Local TypeScript/Playwright and real OpenCode CLI **not run**; this commit's GitHub Actions pending until verified.
- Concurrency: REST Actions in_progress=0 and queued=0 immediately before isolated branch write. No production branch changes.
- Next: inspect exact commit Workbench/Hulane CI and fix any failure first; then complete WB-004 remaining registration/unregister and real three-repository E2E acceptance. Issues #8 and #3 stay open.

### WB-004 checkpoint — 2026-11-22: persisted-ID Git health endpoint

- Task: expose read-only `GET /api/projects/:id/status` for registered repositories only, with UUID validation, missing project handling and fail-closed stale-root response.
- Branch: `feat/WB-004-status-by-id-20261121`; parent `ffe6515051f9aece7d648c0f73fbfd5cf77c96fe`; new remote SHA is authoritative at the branch ref.
- Files: `workbench/apps/api/src/app.ts`, `workbench/apps/api/test/project-status-by-id.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: real HEAD and dirty state by persisted ID; 400 malformed ID, 404 unknown ID, 409 stale root; no absolute filesystem path in errors.
- Validation: source-level review only at commit time; Node test execution and this commit's CI are **unverified** until Actions completes. Real OpenCode CLI not exercised.
- Concurrency: GitHub Actions REST `status=in_progress` and `status=queued` both returned zero immediately before this task; isolated new branch avoids writes to the active WB-004 branch.
- Next: inspect new commit CI and fix failures first; then add strict Web API client and UI display for ID-based health with stale-root/retry/cancellation tests. Keep Issues #8 and #3 open.

# Hulane OpenCode — 会话交接与逐步提交记录

### WB-004 checkpoint — 2026-11-21: unborn HEAD and staged-dirty regression

- Task: add a focused real-Git regression for a newly initialized repository before its first commit, including staged and untracked dirty states.
- Branch: `feat/WB-004-registration-client-20261120`; parent remote SHA: `2891e96e774f99e276bb860c20181f8025305121`; new remote SHA is authoritative at the branch ref (avoid self-referential hash).
- Files: `workbench/apps/api/test/repository-status.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: `readRepositoryStatus` returns `headSha: null`, the real symbolic branch and `dirty: false` on an empty unborn repository; staged and untracked files both report dirty without fabricating a HEAD.
- Validation: static source review only; local Node/Git test execution and new commit CI are **not yet verified**. Previous commit `2891e96e774f99e276bb860c20181f8025305121` Workbench CI [44882886809](https://github.com/hutong236/hulane-opencode/actions/runs/44882886809) and Hulane CI [44882886767](https://github.com/hutong236/hulane-opencode/actions/runs/44882886767) passed; do not apply those results to this change.
- Concurrency: GitHub Actions REST reported zero in-progress and zero queued workflow runs immediately before this checkpoint.
- Next: inspect both CI workflows on the new remote SHA; fix any failure first, otherwise expose real persisted project Git health in Web UI and cover stale/missing repository errors. Keep Issues #8 and #3 open; no Gate bypass or production merge.


> **本文件是 Web/ChatGPT 会话结束后的恢复入口。每完成一个可验收的小步骤，必须立刻 Commit + Push，并在本文件记录新的进展（优先与该步骤同一提交）。**
>
> 续作时始终先读取 GitHub 远程分支当前状态，不依赖上一次会话的聊天记录。工作约定详见仓库根目录 [AGENTS.md](../AGENTS.md)。

## 0. 当前权威状态（2026-11-17；覆盖下文历史阶段说明）

- **主线:** 已通过 [PR #1](https://github.com/hutong236/hulane-opencode/pull/1) squash merge 到 `main`，提交 `db2815a2a694d5447d8ef61fc1148fa416446a09`。此前文档中关于“PR #1 Draft / 禁止合并 / 继续在旧开发分支上开发”的描述仅用于历史追溯，**不再是当前操作指令**。
- **实测 GitHub Actions:** [main push run 42936837021](https://github.com/hutong236/hulane-opencode/actions/runs/42936837021) 已完成，6/6 jobs success；实际验证过的 CI 是开发验证，不是生产 E2E。
- **main 分支规则:** GitHub `GET /branches/main` 于 2026-11-17 返回 `protected:false` / required contexts empty；**主线尚无服务器强制保护**。GitHub 连接权限不包含仓库管理/Ruleset 写入能力。
- **未完成生产验收:** [Issue #3](https://github.com/hutong236/hulane-opencode/issues/3) 仍开放；需要 owner/admin 提供独立私有 sandbox、按实际 check context 配置 Ruleset，完成真实 REQ/BUG-Gate A/B/C-PR-GHCR-Sigstore E2E、Shell OS 隔离、跨会话恢复与实机回滚。
- **当前工作分支:** `chore/post-merge-acceptance-20261117`（从上述 main HEAD 派生），用于修正交接规范并补全后续验收材料；每步提交并核实远端。
- **验收执行手册:** [04 真实 GitHub 沙盒验收手册](./04-真实GitHub沙盒验收手册.md)；**下一独立任务:** 获取管理员配置的独立测试仓库并运行真实服务端检查/负向场景。**没有服务端分支保护和真实安全测试不得宣称生产就绪**。

## 1. 持久化入口

| 项目 | 位置 |
| --- | --- |
| GitHub 仓库 | https://github.com/hutong236/hulane-opencode |
| 当前开发分支 | `feat/opencode-v2-initial-implementation` |
| 代码审查 | [Draft PR #1](https://github.com/hutong236/hulane-opencode/pull/1)（**禁止未经生产门禁验收直接合并**） |
| 总体设计 | [01 总体设计](./01-Hulane-OpenCode-总体设计.md) |
| 开发手册 | [02 开发实施](./02-Hulane-OpenCode-开发实施手册.md) |
| 验证与缺口 | [03 集成验收与缺口](./03-OpenCode-集成验收与缺口.md) |
| 最新源码 | [当前开发分支](https://github.com/hutong236/hulane-opencode/tree/feat/opencode-v2-initial-implementation) |

## 2. 上次代码验证基线（创建本文件时）

- 代码验证提交：`b45ac3aeecfea27d58a828c4ef162628fd4dc637`。
- 验证成功的 Actions：[42848769992](https://github.com/hutong236/hulane-opencode/actions/runs/42848769992)。
- Node.js 20、22：156/156 项回归测试通过；OpenCode SDK 2.2.7 Hook 测试通过；真实 OpenCode CLI v2.2.7 能发现 8 个 Hulane Agent，MCP `hulane-control connected`。
- 已实现：上游 Hulane 3.10.0 状态机/MCP/Worktree/OpenSpec 迁入、10 Commands、7 subagents + 1 orchestrator、Skill、安装器、5 个 MCP 受保护操作、权限隔离与 Coder Worktree 门禁。
- **尚未验收**：真实业务沙盒完整 Gate A/B/C 与 PR/Release/Evidence 链、GitHub Ruleset、Shell 全范围隔离、多进程并发与异常恢复、macOS ARM 和 Linux 实机；不可当作生产发布版本。

## 3. 本次完成的原子步骤

**步骤：建立 Web 会话失效后也可持续开发的 GitHub 断点续作规范。**

- 新增 `AGENTS.md` 和 `docs/SESSION_HANDOFF.md`，更新 README 导航。
- 要求每个小步骤结束立刻提交并推送，不再累积多步骤等到会话结束才提交。
- 这一文档步骤无需修改运行时，原代码测试结果沿用上述已验证基线；本次 GitHub 提交是否触发/通过 CI 必须在推送后实际核查。
- 当前步骤的准确 Commit SHA：在 GitHub PR 的最新提交或执行 `git rev-parse origin/feat/opencode-v2-initial-implementation` 获取；不要把提交内的硬编码 SHA 当作最新。
- 保持 Draft PR，未合并 `main`。

## 4. 下一独立任务（仅选择一个）

**建议优先：生成并提交针对 `@opencode/plugin` 2.2.7 的可复现 `package-lock.json`，让 CI 使用 `npm ci`，严格固定实际运行的 OpenCode CLI 版本，并完成对应 CI 回归。**

验收标准：依赖安装可复现，Node.js 20/22 和真实 OpenCode V2 的四组 CI 均通过；每完成这项任务，**立即推送并更新交接记录**。

后续按优先顺序：GitHub 沙盒业务 E2E → Gate B/C 与 Release/镜像证据 → 权限绕行负向测试 → 并发与崩溃恢复 → macOS ARM/Linux 安装验证。每一项继续拆成单独可推送步骤。

## 5. 会话恢复检查（新会话第一步）

```bash
git fetch origin
git switch feat/opencode-v2-initial-implementation
git pull --ff-only
git rev-parse HEAD
git status --short
npm test
```

同时检查远端 [PR #1](https://github.com/hutong236/hulane-opencode/pull/1) 与 [Actions](https://github.com/hutong236/hulane-opencode/actions) 的最新提交与 CI 状态。若与本文件描述不一致，以 **GitHub 最新远端提交、PR、Actions 结果** 为准并先更新本文件。

### Step 1 — 固定真实 CLI 版本

- Branch: `feat/opencode-v2-initial-implementation`
- Changed: `.github/workflows/ci.yml`
- Implementation: `@opencode/cli` 改为固定安装 `2.2.7`，并在集成 Job 校验 `opencode --version` 精确等于 `2.2.7`。
- Validation: 静态校验和提交已执行；本次 GitHub Actions 完成前不得宣称通过，以该 Commit 对应 Actions 为准。
- Next atomic task: 从 CI 生成真实 npm lockfile 后提交，CI 改用 `npm ci`。

### Step 2 — 由真实 GitHub Runner 生成依赖锁（引导步骤）

- Changed: `.github/workflows/ci.yml`
- Purpose: 临时添加只读 `lockfile-bootstrap` Job，使用 Node.js 22 的 npm 解析实际 `@opencode/plugin@2.2.7` 依赖，输出 `package-lock.json` Base64 至 Actions 日志。
- Validation: 通过 Actions 的 `lockfile-bootstrap` Job 验证；这一步是生成锁文件的可信输入，不把尚未生成的锁文件视为完成。
- Next atomic task: 从已完成的 Job 日志读取实际 Base64、解码、提交真实 `package-lock.json`，删除临时 Job，并切换 `npm ci`。

### Step 3 — 修复精确版本验证误报

- Changed: `.github/workflows/ci.yml`
- Observed CI failure: [Actions 42852390530](https://github.com/hutong236/hulane-opencode/actions/runs/42852390530)。
- Root cause: 真正的 `opencode --version` 输出是 `opencode v2.2.7`，而不是 `2.2.7`。
- Fix: 版本检查精确对比 `opencode v2.2.7`；实际软件已按固定版本成功安装。
- Validation: 当前提交发起新的 CI，结果以对应 GitHub Actions 为准。
- Next: 读取 lockfile-bootstrap 日志，生成锁文件并从临时 Job 转换成 `npm ci`。

### Step 4 — 提交真实 package-lock.json，切换 npm ci

- Changed: `package-lock.json`、`.github/workflows/ci.yml`、`docs/SESSION_HANDOFF.md`。
- Evidence: [Actions 42852462399](https://github.com/hutong236/hulane-opencode/actions/runs/42852462399) 的 `lockfile-bootstrap` Job 成功；原地生成的 lockfileV3 在提交前校验 `@opencode/plugin@2.2.7`，无非预期 npm Registry 网址。
- Change: CI `opencode-v2-adapter` 和 `opencode-cli-integration` 改用 `npm ci`，删除临时 bootstrap Job；CLI 2.2.7 仍被精确固定。
- Validation: 本步骤生成并校验了 lockfile JSON（272 条 package 记录，133474 bytes）；修改后的 CI 结果须查看对应提交 Actions，不能预先标记通过。
- Next atomic task: 对安全授权与持久状态竞态做负向测试与增量加固。

### Step 5 — macOS Apple Silicon 与 Linux ARM64 原生安装 Smoke

- Changed: `.github/workflows/ci.yml`
- Added: `platform-install-smoke` 矩阵：GitHub 官方 `macos-15`（Apple M1 ARM64）和 `ubuntu-24.04-arm`（Linux ARM64）。
- Acceptance: ARM 原生 Node22、锁依赖 `npm ci`、SDK Plugin smoke、精确 CLI 2.2.7 安装、临时 Git 项目 dry-run + 安装、MCP 配置检查。
- Limitation: 本项是 ARM64 **安装与加载 Smoke**，不是实际用户机器端到端安全验收；以对应 Actions 成功结果为准。
- Next: 完善 Work Item 状态变更并发拒绝与锁崩溃恢复测试。

### Step 6 — 加强状态存储并发写入的原子性

- Changed: `hulane/scripts/lib/state-store.mjs`、`hulane/mcp/tools.mjs`、`test/state-store.test.mjs`。
- Implementation: `state-write.lock` 进程间独占写入；根状态修订号 CAS；同修订号 Work Item 冲突拒绝，完全相同的重试幂等；仅显式标记 `source:"github"` 的两处 GitHub hydrate 接受远端覆盖。
- Regression: 新增 3 项锁、CAS、冲突/远端恢复测试；实际 CI 状态待核查。
- Remaining: 中断遗留锁的人工安全恢复机制及并发建单压测。
- Next: 增加防误删活跃进程锁的崩溃恢复工具。

### Step 7 — 崩溃遗留状态写锁的安全恢复

- Changed: `hulane/scripts/lib/state-lock-recovery.mjs`、`bin/recover-state-lock.mjs`、`hulane/scripts/lib/state-store.mjs`、`test/state-lock-recovery.test.mjs`。
- Behavior: 状态写锁加入 hostname；默认恢复 dry-run，仅显式 `--apply` 删除满足同机、PID 确定不存在、锁龄至少 30s 的遗留锁；活跃 PID、外部主机、损坏元数据、新锁一律拒绝；用另一个排他恢复锁避免两个恢复进程竞态。
- Usage: `node bin/recover-state-lock.mjs --project /path/to/repo --dry-run`，核实结果后 `--apply`。
- Regression: 3 项死锁恢复、活跃/异地主机拦截、互斥恢复测试（待 CI 验证）。
- Limit: 不提供不安全的强制解锁；异地主机/损坏锁需管理员线下审计，人工移除前须确保无写进程运行。
- Next: 加强开单编号分配的冲突重试与远端副作用幂等。

### Step 8 — 多进程本地开单编号原子分配

- Changed: `hulane/scripts/lib/state-store.mjs`、`hulane/mcp/tools.mjs`、`test/state-store.test.mjs`。
- Implementation: `createLocalWorkItem` 在同一个进程间锁内重新读取状态、分配 REQ/BUG 全局自增编号并持久化；`hulane_open_work_item` 不再先在锁外取编号。有限锁竞争重试（最多约 500ms），崩溃锁不自动抢占。
- Regression: 原有离线开单/跨前缀编号测试 + 新增编号顺序测试；需以 CI 为准。
- Remaining: 真正并发的多个 OS 进程压力测试、崩溃恢复与云端 Issue 幂等仍需持续验证。
- Next: 添加两个真实 Node 子进程同时创建工单的压力回归并核验连续编号。

### Step 9 — 真实多进程分配回归

- Changed: `test/state-store.test.mjs`。
- New regression: 在同一真实临时 Git 仓库并行启动 4 个独立 Node.js OS 进程，每个创建 8 个 Work Item；断言 32 个编号无重复、数字部分连续、最终 Store 保留 32 个 Work Item。
- Validation: 本提交 CI 执行后才能确定跨进程压力测试是否通过。若锁竞争超时，需要独立修复提交。
- Next: 完整真实 OpenCode CLI 操作链与负向场景；GitHub 沙盒端到端仍然需要独立授权环境和 Ruleset。

### Step 10 — 目标项目既有 allow 规则不能重开 MCP 权限

- Changed: `bin/install.mjs`、`test/opencode-install.test.mjs`、`opencode/README.md`。
- Security: installer 将最终 `hulane-control_*` deny 固定为项目 permissions **最后一条**，覆盖既有 `* allow`、`hulane-control_* allow` 和具体 secure-merge allow；其他项目 Shell 规则照旧，编排 Agent 的单独 ask 配置仍生效。
- Regression: 宽泛和具体 MCP allow 负向测试、重装输出幂等；修订旧有 shell 规则断言（CI 待核查）。
- Next: 对 permission hook 运行时针对 Coder/其他代理的控制和工具调用添加更完整集成测试；继续 PR/Gate E2E。

### Step 11 — Gate B 检查结果与 PR Base 加固

- Changed: `hulane/scripts/lib/pr-checks.mjs`、`test/pr-checks.test.mjs`。
- Security: 同名 check 有任何 pending/failed 即拒绝；逐一要求所有 GitHub branch protection/ruleset 必需 contexts 出现在当前 PR 检查中且全部通过；业务 PR Base 必须是仓库的真实默认分支。
- Regression: 同名冲突、缺失/待运行的必需 context、非默认分支 PR 拦截（新增 3 项测试）。
- Limit: 依旧需要在**独立 GitHub 沙盒仓库**验证 Ruleset 的 App 绑定/权限和实时 Checks 行为；此次为控制面决策逻辑加固。
- Next: 对真实 GitHub sandbox 运行 Gate A/B/C、Release 元数据与负向回滚验收。

### Step 12 — Release Tag 物理对象校验

- Changed: `hulane/templates/github-actions/build-image.yml`、`test/preflight.test.mjs`。
- Security: Tag-only GHCR 工作流拒绝轻量标签；验证远程与本地相同的 annotated tag 对象 SHA；由已验证的 tag 对象解析 commit，并继续校验默认分支祖先关系。
- Regression: 静态工作流安全约束测试；实际 GitHub Release/GHCR 流程仍需独立沙盒发版实验。
- Previous CI: [42855529087](https://github.com/hutong236/hulane-opencode/actions/runs/42855529087) 六 Job 全部通过。
- Next: 防止交付验证仅凭调用者伪造的元数据/摘要就标记 registry_verified。

### Step 13 — 修复 Release workflow 静态检查正则

- Changed: `test/preflight.test.mjs`。
- Fix: 识别 Git 中 `^{commit}` 剥离 annotated tag 的真实语法；原提交中正则遗漏花括号，已在提交后立即复核发现。
- Validation: 变更前本地正则无法匹配；修复后通过源码匹配检查，完整 CI 结果由本次 Actions 确认。
- Next: 避免伪造的交付摘要和声明进入 verified 状态。

### Step 14 — 人工 Gate A/B/C 从 GitHub 证据核验

- Changed: `hulane/scripts/lib/human-approval.mjs`、`hulane/mcp/tools.mjs`、`test/human-approval.test.mjs`、三个 OpenCode 审批 Commands。
- Security: 除低中风险 `auto_intake` 之外，人工事件均须同一 Work Item GitHub Issue 的精确 `HULANE_APPROVAL` 评论；由 GitHub 实际评论作者和 collaborator permission(write/maintain/admin)验证，且绑定当前 revision、Gate B PR Head、Gate C Tag。MCP 参数 `actor=human:xxx` 不再能直接自证人工批准。
- Tradeoff: `pre_authorized` 也需先发布 GitHub Issue/评论才可手工批准；待补建的离线 Issue 不支持人工事件。此变更刻意 fail-closed。
- Regression: 3 项角色、旧 revision、不同作者、过期评论、PR head/tag、API 真实查询调用测试。
- Next: 评估真实 GitHub沙盒门禁（需要独立沙盒仓库与服务端 Rulesets 权限）。

### Step 15 — Signed GitHub Artifact Attestations for GHCR releases

- Changed: `hulane/templates/github-actions/build-image.yml`、`test/preflight.test.mjs`。
- Implementation: 镜像推送完成后由 `anchore/sbom-action@v0` 扫描实际 digest 生成 SPDX JSON，`actions/attest@v4` 分别产生并发布 Sigstore 签名的 SLSA Provenance 与 SPDX SBOM，subject 绑定 GHCR 精确 digest；生成证明失败会中止后续 Release metadata/Release。
- Evidence: 使用 GitHub 官方 attestation 规范；可用 `gh attestation verify oci://ghcr.io/OWNER/IMAGE@sha256:... -R OWNER/REPO --predicate-type https://slsa.dev/provenance/v1` 和 SBOM predicate 单独验证。
- Regression: 工作流具备明确验证步骤、权限、精确镜像 digest 的静态合同测试；真正 GHCR 构建与签名仍需独立沙盒验证。
- Next: `hulane_verify_delivery` 自行执行远端 Actions、Release、GHCR、Sigstore 验证，不再信任 Agent 输入的摘要。

### Step 16 — 独立 GitHub / GHCR / Sigstore 发布证据核验

- Changed: `hulane/scripts/lib/delivery-remote.mjs`、`hulane/mcp/tools.mjs`。
- Security: `hulane_verify_delivery` 不再仅调用纯字段比较；重新查询 GitHub Actions 实际成功的 tag/commit run，查询 GitHub Release 和 annotated tag 对象，下载实际 Release 的 delivery-metadata.json，读取 GHCR Registry tag digest，并用 `gh attestation verify` 对锁定 OCI digest 的 SLSA 和 SPDX 签名证明做独立验证；本地字段摘要取已验证 Statement 哈希。
- Fail closed: 无网络、无 Docker Buildx、无 GH CLI attestation 能力、缺失元数据/签名/授权时不记录 `image_verified`，Issue 保持未完成。
- Current validation: 控制面代码已推送；需要补充注入式真实远端模拟/错误路径单元测试，并在 GitHub 沙盒对真实 OCI attestation 验证。
- Next: 补充远端 Release、GHCR、签名证据正/反向测试并在 CI 上运行。

### Step 17 — 发布事实验证的模拟集成负向测试

- Changed: `test/delivery-remote.test.mjs`。
- New tests (4): 使用实际 `verifyLiveDelivery` 函数与可注入独立 GitHub/OCI 命令模拟器，覆盖成功 Action/tag/Release/Registry/Sigstore 两种 predicate；失败 Workflow、伪造 digest、轻量 tag、缺失 Release asset、元数据篡改、签名目标错误与调用者冒用证明哈希。
- Validation: 完整 CI 必须通过；沙盒真实发布验收仍为单独门槛。
- Next: 文档状态同步、Issue 验收任务列表与生产权限配置。

### Step 18 — 真实 MCP 子进程端到端离线生命周期测试

- Changed: `test/mcp-real-stdio.test.mjs`。
- Actual integration: CI 使用 Node `spawn` 启动实际 `hulane/mcp/server.mjs`（stdio JSON-RPC），逐条执行 initialize、tools/list、离线 open、伪造 human Gate A 拒绝、低风险 auto_intake、Worktree 创建和 status 读取；验证真实 Git worktree 隔离及本地持久化。
- Limitation: 验收范围是 **MCP 真实进程 + 本地 Git**，不代表有权合并真实 GitHub PR、发 GHCR 镜像或真正运行 OpenCode Agent 任务。
- Validation: 本次提交后的 CI 执行结果为准。
- Next: 核查 CI、修复任何集成回归，并记录管理员权限/沙盒生产验收阻塞。

### Step 19 — 与生产验收 Issue 对齐的最新文档

- Changed: `README.md`、`docs/03-OpenCode-集成验收与缺口.md`、`opencode/README.md`、`docs/SESSION_HANDOFF.md`。
- Canonical user-facing blocker and checklist: [Issue #3](https://github.com/hutong236/hulane-opencode/issues/3)。
- Updated: 移除旧的“尚未 lockfile”描述，补充新安全控制、Apple Silicon / Linux ARM Smoke、真实 MCP stdio 与签名验证实现；对于还在排队的 CI 和缺少管理员权限的真实发布验收保持未完成状态。
- Next: 等待最新六项 CI 完成，处理失败项并及时提交；如需外部管理员/独立沙盒，Issue #3 保持待办，不自动合并主分支。

## 6. 后续步骤追加模板

```markdown
### Step N — [独立任务名称]
- Branch / commit: feat/opencode-v2-initial-implementation / <远端 SHA>
- Files changed: ...
- What was implemented: ...
- Validation: ...（通过 / 失败 / 未执行；CI URL）
- Risks / blockers: ...
- Next atomic task: ...
```

**故障回退规则**：提交/推送后如无法确认成功，首先检查远端 SHA；CI 失败保留失败记录并立即以单独修复提交推进。未推送的工作不算完成，禁止无意覆盖别人推送的更新。


### Workbench autonomous scheduler (2026-11-18)

- Branch: `feat/workbench-autodev-30m`; Draft [PR #35](https://github.com/hutong236/hulane-opencode/pull/35).
- Scope: deterministic dependency-aware selection of WB-001..WB-028; prefer red CI, block pending CI and green PRs awaiting human review; GitHub Actions every 30 minutes will run pinned OpenCode V2.2.7 with no GitHub write credentials and a strict workbench edit allowlist; a separate scoped publish step pushes a Draft PR.
- Credential prerequisites: `WORKBENCH_AUTODEV_MODEL` variable plus matching provider secret and `WORKBENCH_AUTODEV_TOKEN`; missing config produces BLOCKED, not a claimed task success.
- Checks: Node 20 and Node 22 core suites passed in [PR run 44152746154](https://github.com/hutong236/hulane-opencode/actions/runs/44152746154); macOS ARM job was still in progress at last review, **full CI not yet certified**. Final security guard also refuses secret-like file names and symlinks.
- Safety: No PR auto-merge, no Issue auto-close, no production Gate bypass. Needs real GitHub Actions scheduled run validation once merged to main; Issue #3 remains open.
- Next: validate full CI on exact final SHA; review+merge PR #35; configure secrets and model variable; dispatch one manual smoke run before relying on cron.

## Workbench Web UI kickoff — WB-001 (2026-11-18)

- Branch: `feat/WB-001-workbench-bootstrap`, PR [#33](https://github.com/hutong236/hulane-opencode/pull/33) (Draft), Issue [#5](https://github.com/hutong236/hulane-opencode/issues/5).
- Initial checkpoint: `a644f4507a7574f0d28e1a309f872d8aa1b5dab6` (27 files under workbench/ plus dedicated CI); React/Ant Design shell, local Fastify health endpoint, Worker/adapter boundaries.
- Evidence: [Workbench CI 44136603060](https://github.com/hutong236/hulane-opencode/actions/runs/44136603060) failed Typecheck (AntD Alert uses `message`, not `title`); root CI 44136524819 failed because `node --test` discovered new TypeScript `.test.ts` file. Root/main baseline remains unchanged.
- Fix: use `message`, rename test to `.spec.ts`, run it with `tsx --test`, enable TS extension import only for no-emit test config. Pending fresh CI verification. Keep PR Draft and do not claim WB-001 complete.
- Next: generate reproducible workbench/package-lock.json; use `npm ci` in workbench CI; implement lint/browser Smoke and run acceptance. GitHub runner may be used because current local container cannot resolve npm Registry (EAI_AGAIN).
- Separately, a read-only 30-minute delivery monitor is proposed by PR [#34](https://github.com/hutong236/hulane-opencode/pull/34); it will not run on schedule until merged into main.


### WB-001 — Fix root test isolation (2026-11-18)

- Failure confirmed: existing [Hulane CI run 44138113271](https://github.com/hutong236/hulane-opencode/actions/runs/44138113271) collected `workbench/apps/api/test/health.spec.ts` under root `node --test`, but root install has no Fastify; 181/182 tests passed before collection failure. It is not a regression of Hulane core assertions.
- Fix root `npm test` to explicitly run `test/*.test.mjs` for the pre-existing core test suite; Workbench tests remain in independent `workbench/ npm test`. New CI must confirm both, and no test is silently dropped from the core suite.
- Next: recheck exact branch SHA, root CI and Workbench CI. Review PR #33, keep #3 untouched.

### WB-001 — Root test discovery regression guard (2026-11-17)

- Task: add a Node built-in regression test enforcing explicit root test glob and independent Workbench test command, preventing accidental Fastify-dependent `.spec.ts` discovery by the root CI.
- Branch: `feat/WB-001-workbench-bootstrap`; PR #33; parent `11dc8ed32b7a544623cb6460c5f682f8aeddf4f3`.
- Files: `test/workbench-test-isolation.test.mjs`, `docs/SESSION_HANDOFF.md`.
- Validation: test is designed for existing root `npm test` on Node 20/22; **not locally executed** in this connector-only execution. Exact post-push Actions must determine pass/fail. Previous [Hulane CI 44153651055](https://github.com/hutong236/hulane-opencode/actions/runs/44153651055) had core Node20/22 success and one cancelled macOS ARM job; [Workbench CI 44153651029](https://github.com/hutong236/hulane-opencode/actions/runs/44153651029) succeeded.
- Risk: cancellation is not evidence of a failing test; do not mark the full Hulane matrix green. No real OpenCode CLI executed in this step.
- Next: inspect the new commit's full CI matrix, diagnose any actual failed job, and finish WB-001 review; keep Issue #5 open until verified acceptance and Issue #3 open for production gates.

### WB-001 — Negative API route regression (2026-11-17)

- Task / acceptance: GET /api/does-not-exist must return HTTP 404 and must not report status=ok; GET /api/health remains covered by existing positive test.
- Branch: `feat/WB-001-workbench-bootstrap`; Draft PR #33; parent `b0a45e415c03f752d8cd7261020e4b22746579b2`.
- Files: `workbench/apps/api/test/health.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Validation: connector-only change; local npm tests **not run**. Previous exact-parent Workbench CI [44172729271](https://github.com/hutong236/hulane-opencode/actions/runs/44172729271) succeeded; Hulane CI [44172728998](https://github.com/hutong236/hulane-opencode/actions/runs/44172728998) marked failure solely with macOS ARM job cancelled, five other jobs succeeded. New SHA CI is pending verification; no real OpenCode CLI run here.
- Concurrency: 100 latest Actions runs showed no queued/in-progress jobs at pre-write check; PR #33 head matched parent. GitHub auto-coding workflow in PR #35 is not merged into main.
- Risk: API negative path test not yet verified by runner; full Hulane matrix not green. Issue #5 and production Issue #3 remain open.
- Next: inspect new CI for this commit; investigate macOS ARM cancellation if reproducible, then add lint command and finish WB-001 acceptance.

### WB-001 checkpoint — source lint and CI gate (2026-11-18)

- Task: Add a deterministic zero-dependency Workbench source lint command, CI gate and regression tests; keep the existing independent npm lockfile unchanged.
- Branch: `feat/WB-001-workbench-bootstrap`; parent `6c537e3fcee4b98ddd2425e377c11fedac58481c`. The authoritative new SHA is the remote branch HEAD after push.
- Files: `workbench/package.json`, `workbench/scripts/lint.mjs`, `workbench/test/lint.test.mjs`, `.github/workflows/workbench-ci.yml`, this handoff.
- Acceptance: `npm run lint` rejects unresolved conflict markers, trailing whitespace, CRLF and missing final newline in Workbench source files; Node test fixtures cover positive/negative cases; Node 20/22 Workbench CI runs lint before typecheck/build/test.
- Validation: GitHub API source inspection only before push; no local `npm ci`, `npm run lint` or `npm test` executed in this session. CI for the new commit is pending until an actual Actions run is observed. Previous branch HEAD `6c537e3fcee4b98ddd2425e377c11fedac58481c` had successful Workbench/Hulane CI runs 44192490340/44192490474.
- Risk: This is intentionally a narrow source-hygiene lint, not a full ESLint ruleset. Existing files may require style cleanup if CI flags violations. No production Gate #3 claim.
- Next: inspect the new SHA's Workbench/Hulane CI; fix any real lint failure in a separate checkpoint, then complete WB-001 remaining browser/runtime acceptance.


### WB-002 — SQLite schema and storage foundation (2026-11-18)

- Issue [#6](https://github.com/hutong236/hulane-opencode/issues/6), branch `feat/WB-002-sqlite-foundation`, starting from `main` `cc9288bf2bca2e87f9856db5eb626e9688d94b6b`.
- Scope: ten-table SQLite schema, WAL/foreign keys/busy timeout, transactional SHA-checked migrations, project CAS repository, backup, isolated tests and storage boundaries.
- Validation: GitHub CI dependency generation/checkpoint pending (runner must resolve SQLite native driver). No local npm network available in this environment; do not report tests as passed until CI runs.
- Next: capture and commit independently generated Workbench lockfile; return CI to `npm ci`; run Node 20/22 API+DB+Workbench and existing Hulane suites; fix failures before PR is reviewable.


### WB-002 checkpoint — lockfile and types (2026-11-18)

- Previous checkpoint `d39da5741cf63cd30a41c06853d7768a8d5c82c5`: [Workbench CI 44229008803](https://github.com/hutong236/hulane-opencode/actions/runs/44229008803) found three TypeScript test `unknown` cast failures, while native dependency installation and source lint succeeded.
- Current step: commit Runner-generated `workbench/package-lock.json`, restore `npm ci`, add typings for SQLite count queries, use canonical macOS temporary test directories, clean isolated fixtures, publish ESM package typing exports.
- Verification status: fresh CI for this checkpoint pending. Full sqlite tests, root regression, macOS/Linux compatibility and correct WAL backup behavior must be checked in Actions; no test result is invented.
- Next: inspect exact HEAD CI for both Node 20/22; fix real failures, review DB migration/backup and repository boundaries, then open PR #6 and retain production #3.


### WB-002 — Atomic migration history and SQLite writer contention (2026-11-18)

- Existing HEAD `8946f80e8e60318f03427a56951245bf554d83ac` was verified by [Workbench CI 44229238584](https://github.com/hutong236/hulane-opencode/actions/runs/44229238584) (Node 20/22 2/2 success) and [Hulane CI 44229238505](https://github.com/hutong236/hulane-opencode/actions/runs/44229238505) (6/6 success).
- This checkpoint moves migration history reads and writes into the same SQLite BEGIN IMMEDIATE transaction, preventing concurrent startup races. Adds busy-timeout contention and migration tampering negative tests.
- No OpenCode CLI invocation from this development session; existing Hulane CI exercises its own CLI separately.
- Current step's CI pending until actual GitHub Actions status is observed. Next: verify final SHA, open PR for Issue #6 and confirm all acceptance gates.


### WB-003 — Browser Shell first checkpoint (2026-11-18)

- Issue #7, branch `feat/WB-003-web-shell-routing` based on `main` `ad726e5a499e893f5d4dc4a8251e243d70081685`.
- Added six URL routes, browser history handling, responsive mobile Drawer, breadcrumbs, error boundary, real /api/health state and retry, local-only theme preference and honest disabled business pages. Added route and API error unit tests.
- No additional npm packages in this checkpoint. CI status unverified until the exact new SHA runs. No core Hulane paths were changed.
- Next: inspect Workbench/Hulane CI, then add Playwright smoke and lockfile, verify deep-link refresh and mobile navigation. Production Issue #3 remains open.


### WB-003 Playwright browser tests checkpoint

- Earlier HEAD `0c0a35a5c5bc87bb29aa6d42655631cdde450068`: Workbench CI 44230432635 (2/2 passed), Hulane CI 44230432632 (6/6 passed).
- Added pinned Playwright Chromium and tests for six browser routes, reload, HTTP 500 retry, mobile Drawer and local theme persistence.
- Temporarily run npm install to export exact lockfile. This checkpoint's CI remains pending. Next: commit lockfile, restore npm ci, verify browsers and regression, open PR. Production #3 is unchanged.


### WB-003 — Lockfile + supported Playwright runner (2026-11-18)

- Previous HEAD `f1cc7c629716e4cc67bfea546c71dc92279adeff`: [Workbench CI 44230774775](https://github.com/hutong236/hulane-opencode/actions/runs/44230774775) Node 20 passed; Node 22 failed to install Chromium because `ubuntu-latest` resolved to Ubuntu 26.04, unsupported by pinned Playwright 1.56.1. Source compile/unit tests were not the reported failure.
- New checkpoint pins Workbench CI runner to `ubuntu-24.04`, commits npm lockfile from a real runner installation, returns CI to `npm ci`. E2E browser pass/fail pending on this SHA.
- Next: inspect 4 Playwright browser smoke cases; fix actual failures before approval and PR #38 merge. Production #3 remains open.


### WB-003 — Use GitHub runner's preinstalled Chrome (2026-11-18)

- Workbench CI 44231007520 had Node 20 test/build success while Node 22 Playwright Chromium download remained in progress. GitHub Ubuntu 24.04 x64 image documents Google Chrome as preinstalled; Playwright supports `channel: chrome`.
- Switch E2E from downloaded bundled Chromium to preinstalled Chrome, explicitly verify `google-chrome --version`, removing repeated browser binary installation. Tests still run in real headless Chrome.
- Actual browser test result for this change remains unverified until fresh CI. No affected production gates (#3) or privileged tool calls.


### WB-003 — Separate Node 20 HTTP smoke from Node 22 browser E2E

- At HEAD `4a9923f01d5608d11d6a4a02c51d010b8161b425`, Workbench CI [44231451726](https://github.com/hutong236/hulane-opencode/actions/runs/44231451726) Node 22 browser step failed BEFORE tests: the previous HTTP smoke started `npm run dev`, and its child service stayed bound to port 3000. Playwright refused to reuse it under CI strict mode. Node 20 tests succeeded.
- Fix: run independent HTTP smoke only on Node 20; Node 22 will test an isolated fresh server through Playwright's built-in `webServer`. Both suites still validate true `/api/health` connectivity.
- New SHA requires CI verification before merging PR #38. Production Issue #3 unchanged.


### WB-003 — Shared UI primitives and confirmed theme reset

- Exact prior HEAD `74e31df30d524035c99ac4c3a71b385336d34e1f`: [Workbench CI 44231617335](https://github.com/hutong236/hulane-opencode/actions/runs/44231617335) Node 20/22 green, including **4/4 browser E2E**; [Hulane CI 44231617289](https://github.com/hutong236/hulane-opencode/actions/runs/44231617289) 6/6 green.
- This change adds reusable empty DataTable and Popconfirm components, and uses confirmation to reset browser-local theme. Adds a Playwright test covering cancel and confirm actions.
- New CI results pending; do not mark PR #38 ready or Issue #7 accepted before exact new SHA passes.


### WB-003 — Stabilize Popconfirm E2E locator

- [Workbench CI 44231934598](https://github.com/hutong236/hulane-opencode/actions/runs/44231934598) previous HEAD `bc083e8af61ff0619e9af8069c4063cf867abdf5`: 4 existing Playwright tests passed, new confirmation test failed at a role/name locator for the Cancel action; actual confirmation title was visible. Node 20 passed, Node 22 test exit failed.
- Replace locale-sensitive accessible-name selector with scoped `.ant-popconfirm-buttons button` DOM selection and assert both controls exist. New CI must verify cancel and confirm behavior. Hulane production gate #3 unchanged.


### WB-004 — Canonical Git repository root validation (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `b908c34f0f1a596ec15342e59e96435014526bd3`; authoritative SHA is the verified remote HEAD.
- Scope: reusable fail-closed registration boundary: absolute path, no symlink components, real Git worktree root, Git invoked without a shell.
- Regression: temporary Git root, nested directory, non-Git directory, relative path and symlink alias.
- Validation: connector-only source changes; local npm/tsx tests **not run**. Check exact-SHA Actions before claiming success. Issue #8 CRUD/UI remain incomplete.
- Next: check CI, then integrate validation and duplicate detection into project registration. Production Issue #3 remains open.

### WB-004 — Fail-closed Git worktree and environment isolation (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `f0c9b3b3de73a3a14226bbd3aaecda7399ad8d88`; current remote HEAD must be checked after push.
- Scope: reject bare repositories, require `--is-inside-work-tree=true`, and strip inherited Git location overrides before subprocess validation.
- Regression: bare repository and hostile `GIT_DIR` redirect; retain existing canonical/nested/symlink tests.
- Validation: connector-only edit; local tests **not run**. Previous parent Workbench CI 44235079874 and Hulane CI 44235079936 passed; new SHA requires its own CI evidence.
- Risk: project registration CRUD/UI and duplicate-path persistence remain incomplete; Issue #8 stays open.
- Next: wire validated canonical root into project registration and add duplicate registration rejection tests; no production Gate approval (#3).

### WB-004 — Git root pre-registration API boundary (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `671b1774482b33df79eb3a9f0f9a2a34a5daa752`; authoritative commit SHA is remote branch HEAD after push.
- Scope: `POST /api/projects/validate` uses canonical Git root validator; rejects missing/non-string and invalid paths with HTTP 400, without returning local Git stderr or rejected paths.
- Regression: Fastify inject test for real temporary Git repository, non-Git directory, relative path and invalid body types.
- Validation: connector-only code change; local tests **not run**. Parent Workbench CI 44247948169 and Hulane CI 44247948168 succeeded; new SHA CI must be checked independently. Real OpenCode CLI not exercised.
- Risk: this endpoint validates only; it does not persist registrations or implement CRUD/UI. Issue #8 and production Issue #3 remain open.
- Next: implement atomic database-backed registration with canonical root uniqueness and duplicate rejection, then connect UI.

### WB-004 — Persistent repository-root uniqueness regression (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `83ec0ea5886bee669288ac083936ec73a7d9ee21`; latest SHA is the verified remote branch HEAD.
- Scope: add `ProjectRepository.findByRoot` for canonical-root lookup; retain SQLite `repo_root UNIQUE` as the authoritative atomic duplicate guard.
- Regression: two distinct slugs cannot register the same root; lookup and duplicate rejection persist after database close/reopen; failed registration leaves one record.
- Validation: GitHub connector-only source edit; local `npm test` **not run**. Check exact new SHA Workbench CI and Hulane CI before claiming pass. No real OpenCode CLI exercised.
- Limitation: the API registration endpoint is not yet connected to this repository, and path canonicalization must occur before calling `create`; Issue #8 stays open.
- Next: add `POST /api/projects` backed by `validateRepositoryRoot` and `WorkbenchDatabase.projects.create`, map SQLite uniqueness errors to HTTP 409, and test API persistence and duplicate requests. Production Issue #3 remains open.

### WB-004 — Git environment override hardening (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `38b5d712bc166b1fc46d6351df6cc87b4755dea6`; authoritative SHA is remote branch HEAD after push.
- Scope: strip all inherited `GIT_*` variables before running Git root validation, including injected `GIT_CONFIG_*` and alternate object directories; preserve non-Git process environment.
- Regression: a real temporary Git repository remains valid despite hostile `GIT_CONFIG_COUNT` / `core.bare` and `GIT_OBJECT_DIRECTORY` overrides.
- Validation: connector-only code change; local tests **not run**. Exact new SHA CI must be checked after push; real OpenCode CLI not exercised.
- Next: implement `POST /api/projects` using canonical root validation and SQLite persistence, map duplicate registration to HTTP 409, and add Fastify API regression. Issue #8 and production Issue #3 remain open.

### WB-004 — Cross-connection duplicate-root regression (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent `ad0dfcf1a76531300ce3b9efe07a13270cc04611`; authoritative SHA is the remote branch HEAD after push.
- Files: `workbench/packages/database/test/project-root-concurrency.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: two independent SQLite connections see the same registered canonical root; a second slug cannot register it; exactly one row survives reopen.
- Validation: source-level regression authored via GitHub connector; local `npm test` **not run** in this execution environment. Exact-commit Workbench/Hulane CI must be checked after push; never assume green.
- Blockers: API `POST /api/projects` and CRUD/UI still missing; Issue #8 remains open. Production Issue #3 remains open.
- Next atomic task: connect validated Git root with persistent project registration API, returning HTTP 400 for invalid input and HTTP 409 for duplicate roots, with Fastify inject tests.

### WB-004 checkpoint — read-only real Git status (2026-11-18)

- Branch: `feat/WB-004-repo-root-validation`; parent verified before edit: `2cceaf02e6807ed8118c20a477266f5e0bfe504e`.
- Files: `workbench/apps/api/src/repository-status.ts`, `workbench/apps/api/test/repository-status.spec.ts`, this handoff.
- Scope: read-only canonical-root Git status (HEAD SHA, branch including detached HEAD, dirty flag); no shell and no inherited GIT_* overrides. Regression covers clean/dirty/detached and nested-path rejection.
- Validation: source and test committed via GitHub API; local npm/typecheck/tests **not run** in this environment; Actions on the new commit must be checked before marking success. Real OpenCode CLI not exercised.
- Risk: status snapshot is non-atomic if repository changes between Git invocations; API persistence and CRUD/UI still missing.
- Next: inspect new CI, then implement POST /api/projects with SQLite and HTTP 400/409 tests.

### WB-004 checkpoint — Fastify path safety boundary regression (2026-11-19)

- Branch: `feat/WB-004-repo-root-validation`; parent remote SHA: `e6b1f455d9dfff2105d1c23452a72758586f79f4`.
- Added `workbench/apps/api/test/project-path-guards.spec.ts` to assert that the real Fastify validation endpoint accepts a canonical Git root, rejects nested directories and symlink aliases (including paths beneath aliases) with HTTP 400, and never returns local paths in error responses.
- Validation: test not run locally (GitHub API-only execution); CI for this new commit must be checked separately. The parent SHA's Workbench CI #44441483564 and Hulane CI #44441483557 succeeded; this is not evidence for the new test.
- Concurrency preflight: repository Actions run listing showed no queued/in-progress jobs, including the scheduled autonomous-development workflow; verify again before any subsequent write.
- Next: check new CI; then implement `POST /api/projects` with persistent SQLite registration and HTTP 400/409 regression tests. WB-004 and production acceptance #3 remain open.


### WB-004 checkpoint — read-only Git status HTTP endpoint (2026-11-19)

- Branch: `feat/WB-004-repo-root-validation`; parent remote SHA: `29a30f07e84c09c269a89497c228117216a3a3ee` (new remote SHA must be verified from the branch after push).
- Changed: `workbench/apps/api/src/app.ts`, `workbench/apps/api/test/project-status-api.spec.ts`, and this handoff.
- Acceptance: `POST /api/projects/status` returns actual HEAD SHA, branch and dirty state for a validated Git root; malformed, nested and missing paths fail HTTP 400 without leaking filesystem paths; detached HEAD is represented by a null branch.
- Validation: local npm tests/typecheck **not run** in this GitHub API-only environment. Parent commit Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44455078067 and Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44455078059 succeeded; new commit CI must be checked separately. Real OpenCode CLI not exercised.
- Concurrency: before write, repository Actions list showed 0 queued and 0 in-progress runs; recheck before updating ref.
- Next independent task: check this commit's CI, then implement SQLite-backed `POST /api/projects` with dependency/lockfile, HTTP 201/400/409 and persistence regression tests.

### WB-004 checkpoint — disable repository-configured Git fsmonitor execution (2026-11-19)

- Branch: `feat/WB-004-repo-root-validation`; parent verified SHA `a4f0bef2b3bca02974ad7d5d04dcf84949ccafb6`. The remote ref after push is authoritative.
- Scope: force `core.fsmonitor=false` and an inert hooks path for all read-only Git status commands, preventing an untrusted repository's fsmonitor executable from being launched during API status reads.
- Regression: create a real Git repository with a configured fsmonitor shell script and assert status succeeds without creating the script's execution marker.
- Validation: source/test authored through GitHub connector; local tests and typecheck **not run**. Parent Workbench CI #44502497069 and Hulane CI #44502497035 passed; new SHA CI must be checked independently. Real OpenCode CLI not exercised.
- Next: check new CI; then implement SQLite-backed `POST /api/projects` with HTTP 201/400/409, durable registration and workspace dependency/lockfile updates. Issue #8 and production #3 remain open.

### WB-004 — SQLite project registration checkpoint (2026-11-19)

- Added POST /api/projects with canonical Git-root validation, HTTP 201/400/409, SQLite uniqueness handling and lazy database lifecycle.
- Added regression for invalid path, duplicate registration and persistence across SQLite reopen. Updated API workspace dependency and lockfile.
- Validation: local tests/typecheck **not run**; new commit CI **not yet verified**; real OpenCode CLI not exercised. Production Issue #3 remains open.
- Next: inspect exact commit CI, fix failures before implementing project list/detail/delete API and UI.

### WB-004 — CI TS2307 database declaration build-order repair (2026-11-19)

- Isolated fix branch: `fix/WB-004-database-build-order-20261119`, based on WB-004 registration commit `2659fd40a1605a87cf883852d5d869db14047532` to avoid conflicting with the active automation branch.
- Observed failed Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44529026354 (Node 20 and 22): `src/app.ts` and `test/project-registration.spec.ts` TS2307 cannot resolve `@hulane/workbench-database` because package `types` points to `dist/index.d.ts`, which is absent before build.
- Fix: root workbench `typecheck` and `build` scripts prebuild the database workspace, producing its published declaration/runtime outputs before dependent API checks and builds.
- Parent Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44529026378 marked failure with 5 successes and one cancelled macOS job; do not claim successful CI. This isolated fix has not been tested locally; new Actions must confirm it.
- Next: inspect new fix PR CI; if green, integrate this fix into WB-004 safely after verifying concurrent writer state, then continue project list/detail/delete APIs and Web UI. Keep Issues #8 and #3 open.

### WB-004 — project detail endpoint checkpoint (2026-11-19)

- Isolated branch: `feat/WB-004-project-detail-20261119`, parent `b9b6f972dd0b1b454c3acaa09003495ca6257702` (PR #40 CI-green build-order repair).
- Scope: add `GET /api/projects/:id` for persisted project metadata with UUID input guard, HTTP 200/400/404 and no filesystem paths in errors. No repository mutation.
- Regression: Fastify inject test registers a real temporary Git repository, checks exact stored record, malformed ID and missing ID.
- Validation: local npm tests/typecheck **not run** in GitHub API-only environment; CI on the new commit is pending until verified. Parent PR #40 Workbench CI #44539518268 and Hulane CI #44539518237 succeeded; real OpenCode CLI not exercised.
- Next: inspect exact new commit CI, then implement project listing and deletion of registration without deleting Git files. Do not close Issues #8/#3 or merge production.


### WB-004 — SQLite project list API (2026-11-19)
- Branch: `feat/WB-004-project-list-20261119`; parent: `e875f6cca87b88557432a5cbb8a4b49f71dbc04b`; Draft PR follows branch creation.
- Acceptance: GET /api/projects returns 200 with an empty array or persisted project metadata in deterministic created_at/id order; no filesystem/Git access during listing.
- Changed: database ProjectRepository.list(), Fastify GET route, new project-list.spec.ts regression, this handoff.
- Validation: GitHub connector-only edit; local npm test/typecheck **not run**; new SHA CI must be checked after push. Parent SHA Workbench CI 44560530322 and Hulane CI 44560530218 both succeeded. Real OpenCode CLI not exercised.
- Risk: list currently unpaginated; project registry UI and safe unregister remain outstanding. Issue #8 and production Issue #3 remain open.
- Next atomic task: check new SHA CI and repair any failures; otherwise implement safe project unregister without deleting repository files.


### WB-004 — SQLite-only safe project unregister (2026-11-19)

- Isolated branch: `feat/WB-004-safe-unregister-20261119-2005`, based on verified list endpoint SHA `955ea6a53a2970e87977f10eda9c3b3018f6e575`; no writes to existing development branches.
- Scope: `DELETE /api/projects/:id` with UUID guard, 204 on successful unregister, 400 for malformed IDs and 404 for missing IDs; `ProjectRepository.delete` executes only `DELETE FROM projects WHERE id = ?` in SQLite.
- Regression: `project-unregister.spec.ts` registers a real temporary Git repository, checks 204/400/404, absence of registration after deletion, preservation of `.git` and a user marker file, and no filesystem path in errors.
- Validation: source/test authored via GitHub connector; local npm test/typecheck **not run**. Parent list SHA Workbench CI #44572313223 and Hulane CI #44572313392 completed successfully; new SHA CI must be checked independently. Real OpenCode CLI not exercised.
- Concurrency: this change is isolated on a newly named branch; no writes to main or active half-hour automation branches. Repository-wide active Actions cannot be conclusively enumerated through this connector.
- Risk: UI, live health status and full WB-004 acceptance remain outstanding; Issue #8 and production Issue #3 remain open.
- Next: inspect this branch's exact CI and fix failures first, then implement project management Web UI and real Git health display.


### WB-004 — Strict project list client contract (2026-11-19)
- Branch: `feat/WB-004-project-client-20261119-2359`; isolated from all existing development and scheduler branches; parent `0a17b2156cf24ff1bb0baf6ab0586fe379855549`.
- Code: `getProjects` uses existing same-origin `requestJson`; `decodeProjectList` checks envelope, record fields, UUID, absolute repository root, nonnegative integer revision, and duplicate IDs before rendering.
- Regression: `project-list-client.spec.ts` checks empty/valid responses and malformed/duplicate data.
- Validation: GitHub connector writes only; local `npm test`, `npm run typecheck`, browser smoke, and real OpenCode CLI **not run**. Parent Workbench CI #44605266143 and Hulane CI #44605266115 succeeded; new SHA CI pending verification.
- Concurrency: new isolated branch only; connector cannot fully enumerate scheduled half-hour Actions jobs. No write to `main` or shared feature branches.
- Risk: project UI not yet connected, project status UI and complete WB-004 acceptance outstanding. Issues #8 and #3 remain open.
- Next atomic task: inspect exact-commit CI and fix failures; then add project list loading/empty/error/retry UI.


### WB-004 — project list UI states (2026-11-20)
- Branch: `feat/WB-004-project-list-ui-20261120-0056`; parent verified `03e699f1e373d4b873d1e6725cc3a1facf1fc5ad` (remote branch SHA after push is authoritative).
- Scope: connect /projects to validated getProjects() with loading, empty, error/retry, and read-only project table. Abort stale requests on unmount/retry.
- Validation: parent Workbench CI #44642346340 and Hulane CI #44642346203 succeeded; this commit's CI pending. Local tests/typecheck/browser smoke and real OpenCode CLI not run in connector-only environment.
- Risks: registration, details, unregister, and live Git status Web controls remain unimplemented; no production acceptance. Issues #8 and #3 stay open.
- Next: inspect exact new SHA CI; fix any failures, then add browser UI regression/smoke for loading/empty/error/retry.

### WB-004 — HTTP request regression (2026-11-20)

- Branch: `test/WB-004-project-list-request-20261120-0304`, parent `a3e286236d0fcc5df7b525cc1e7a6fba61e37bd3`; authoritative new SHA is remote branch HEAD.
- Change: `workbench/apps/web/test/project-list-request.spec.ts` tests 503 then retry/empty result, AbortError propagation, malformed response rejection.
- Validation: local `npm test --workspace @hulane/workbench-web` and typecheck NOT RUN (GitHub connector has no local Node environment). Parent CI: Workbench 44649896984 and Hulane 44649896991 passed. New CI pending verification.
- Risk: HTTP client regression only, not DOM/browser smoke or real OpenCode CLI. No production Gate approval.
- Next: inspect new CI and add browser smoke covering loading, empty, failure, retry and stale request cancellation.


### WB-004 checkpoint — project list malformed-response recovery regression (2026-11-20)

- Step: Add two deterministic request-level regression tests: HTTP 200 malformed JSON must reject without poisoning the next valid retry; transport failure messages must not expose the underlying exception's sensitive text.
- Branch: `test/WB-004-project-list-failure-recovery-20261120` (isolated from `test/WB-004-project-list-request-20261120-0304`).
- Code commit before this handoff: `c191adec29e630e0bd37f1f09459db950e564b96`; authoritative final SHA is the remote branch HEAD.
- Files: `workbench/apps/web/test/project-list-request.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Validation: Parent commit Workbench CI runs 44665278910 / 44665269707 and Hulane CI 44665278893 succeeded. New commit tests, typecheck, browser Smoke and real OpenCode CLI are **not run locally**; new Actions results must be inspected before claiming success.
- Risk / blocker: These are HTTP-client regressions, **not** real browser interaction tests. No production Gate A/B/C verification. Issue #8 and Issue #3 stay open.
- Next step: Inspect this branch's CI; then add browser-level loading/empty/error/retry/cancellation coverage with an actual browser runner, without weakening Hulane Gate.


### WB-004 checkpoint — same-origin project list client guard (2026-11-20)

- Branch: `test/WB-004-project-client-origin-guard-20261120` (isolated from verified parent `3516496c861b018c70682719681392d44bfa4298`).
- Code commit: `68278df39d7a8562ab7797e79869a620988a7afb`.
- File: `workbench/apps/web/test/project-list-origin-guard.spec.ts`.
- Acceptance: assert GET project list uses same-origin `/api/projects`, JSON Accept, no-store and no explicit credentials; reject absolute/protocol-relative/non-API URLs without issuing fetch.
- Prior parent CI: Workbench #44671304861 success; Hulane #44671304879 success. New tests not run locally; new commit CI unverified until checked.
- Risk: this is request-level Node regression, not browser Smoke or production Gate A/B/C. No actual OpenCode CLI validation.
- Next: check new branch CI, repair failures first; then add browser-level project-list loading/empty/error/retry smoke.


### WB-004 checkpoint — Playwright project list browser regression (2026-11-20)

- Step: Add browser-level coverage for pending project list loading, real metadata rendering, empty-list refresh, HTTP 503 retry recovery, and navigation away from a pending request.
- Branch: `test/WB-004-project-list-browser-20261120-1100`, based on verified PR #48 head `754ac92ea33919075ddb6bfde4da8e41b013e40c`; code commit `bf9c609aa358a0a0c49d377602f522c6cc4e00b2`. Final remote branch HEAD after handoff is authoritative.
- Files: `workbench/e2e/project-list.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: Playwright tests must pass in Chrome via `cd workbench && npm run test:e2e`; CI at final branch SHA must be inspected. Browser tests authored, **not run locally**; new CI pending. Real OpenCode CLI and production Gate A/B/C **not run**.
- Concurrency: GitHub Actions repository-wide queued and in_progress queries both returned 0 before writing; last scheduled autonomous development run #44721080097 was completed/success. No writes to main or shared task branches.
- Risk: This is read-only list UX regression, not full project registration/detail/health UI acceptance. Issue #8 and production Issue #3 remain open. PR dependency chain #39–#48 must be reviewed before any merge.
- Next: inspect exact new SHA CI, fix failures first; then implement/verify project registration and health controls in the Web UI without bypassing Hulane Gate.


### WB-004 — Repair browser CI under React StrictMode (2026-11-20)

- Step: Fix failing PR #49 Playwright assertions (Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44724177979, Node 22 browser E2E: 3 failed, 1 passed; Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44724177744 passed).
- Branch: `fix/WB-004-playwright-strictmode-20261120`, based on PR #49 head `6fc29947f2267b0d3eaad549f939cc16410d3abf` (not main, to preserve the failing browser test context).
- Files: `workbench/e2e/project-list.spec.ts` and this handoff.
- Change: React.StrictMode runs the initial effect twice in development; route fixtures now keep initial empty/error outcomes through two requests and accept subsequent refresh/retry, while cell locators disambiguate duplicated DOM matches. The original browser tests and cancellation coverage remain in place.
- Validation: source/log inspection only. New SHA CI and local Playwright **not run/verified** at this checkpoint; real OpenCode CLI not exercised. Exact remote branch HEAD is authoritative after this handoff commit.
- Risk: the fixture assumes two initial requests in dev; verify exact Node 22 browser results before accepting. Do not close Issue #8 or production Issue #3.
- Next: inspect fresh Workbench CI Node 20/22 and Hulane CI for this fix; if red, use browser traces to repair the next failing assertion before adding WB-004 project registration UI.


### WB-004 — Fix empty-list refresh browser regression (2026-11-20)

- Step / acceptance: On the project list, after an empty response, clicking the Card refresh action must display a newly registered project, regardless of React StrictMode initial request count.
- Branch: `fix/WB-004-empty-refresh-e2e-20261120`, parent `aa4ce0973b09c5943149345ec61426efbf6cfb23` (stacked on Draft PR #50). Code commit: `013f077ad99dc61973c305db6532f51b9553862a`; authoritative final SHA is remote branch HEAD.
- Files: `workbench/e2e/project-list.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Failure evidence: Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44732780377 Node 22 failed 1/9 browser cases (8 passed): timeout waiting for `getByRole('button', { name: '刷新' })`; Node 20 succeeded. Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44732780438 succeeded.
- Change: scope click to `.ant-card-extra button` and switch mock response based on explicit refresh phase, rather than relying on exactly two StrictMode initial requests. Keep assertion that the newly returned project appears.
- Validation: source reviewed against actual `ProjectList.tsx`; local Playwright and real OpenCode CLI **not run**. New commit CI pending and must be checked before claiming pass.
- Risk: stacked PRs need review; this does not satisfy project registration/Git health UI or production Issue #3.
- Next: inspect exact SHA Workbench/Hulane CI; fix any failure, then implement project registration and Git health UI controls.

### WB-004 — Safe browser registration API client (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`, stacked on PR #51 SHA `3afefaa50781ed3d2aa5da7f9c84c0ea5381d2bf`.
- Changed: `workbench/apps/web/src/api/client.ts`, `workbench/apps/web/test/project-registration.spec.ts`.
- Acceptance: local-only POST /api/projects with validated input and persisted response; duplicate/unsafe-path errors mapped without leaking server text; abort preserved. Server remains authoritative for realpath and Git root checks.
- Validation: new Node test cases added for success, invalid input, HTTP 400/409, malformed response and abort. No local npm or real OpenCode CLI execution in this API session; exact new commit's CI must be checked after push.
- Risk: registration UI and live Git health status are not yet wired. Issue #8 and production Issue #3 remain open.
- Next atomic task: add project registration form to ProjectList, show safe validation failures and refresh persisted list, with browser E2E.

### WB-004 checkpoint — 2026-11-20: repair incomplete Git tree

- Step: Restore the complete inherited repository tree on PR #52; the prior commit `b7fdcfbabfcaa6f474128cc875de5ed7186eb50c` accidentally used a root tree containing only 10 entries, omitting AGENTS.md, package manifests and most source files.
- Branch: `feat/WB-004-registration-client-20261120`; parent: `b7fdcfbabfcaa6f474128cc875de5ed7186eb50c`.
- Files: repository tree restored from parent PR #51 tree `78687d196cd8ceaf7ded0929a6e1f55affcf6e19`, preserving PR #52 registration client and test blobs; this handoff entry records the correction.
- Validation: GitHub Git Trees API confirmed PR #51 base tree contains 274 entries and defective PR #52 tree only 10; restored tree must be verified remotely after push. Local npm/typecheck/Playwright not run. CI pending; real OpenCode CLI not run.
- Risk: Do not treat the prior commit as a buildable full checkout. Production Gate remains unverified.
- Next: Inspect PR #52 Workbench/Hulane CI and fix any failures; then implement registration form and project list refresh.


### WB-004 — Web registration form and list refresh (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`; parent remote SHA `e68213e47ed133c200f47868ee0723a76d214a0f` (new HEAD is authoritative after push).
- Files: `workbench/apps/web/src/components/ProjectList.tsx`, `docs/SESSION_HANDOFF.md`.
- Acceptance: project form accepts absolute path, slug and name; calls existing same-origin `registerProject`; prevents duplicate in-flight submit; shows sanitized 400/409 errors; resets form and reloads persisted list on success; aborts pending request on unmount.
- Validation: source review only in GitHub API environment; npm, TypeScript, Playwright and real OpenCode CLI not executed. Prior Workbench CI #44788480278 passed, Hulane CI #44788480158 failed due to cancelled macOS smoke job; new commit CI must be checked separately.
- Concurrency: repository Actions queue and in-progress runs were both zero before write (GitHub REST repository Actions collection).
- Risk: browser E2E for registration and real Git health status still missing; Issue #8 and production Issue #3 remain open.
- Next: inspect exact new SHA CI; fix failures first, then add Playwright registration/error/list refresh coverage and Git health status.


### WB-004 — Browser registration regression checkpoint (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`; parent: `f9e08caf67c7c7be31a7a9a3001e443a2d408bc0`; authoritative new SHA is remote branch HEAD.
- Files: `workbench/e2e/project-registration.spec.ts`, this handoff.
- Acceptance: Playwright verifies local POST payload and persisted list refresh, duplicate 409 redaction, and relative path rejection without POST.
- Evidence: prior commit `f9e08caf67c7c7be31a7a9a3001e443a2d408bc0` Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44826052995 and Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44826053009 both completed success. New tests not locally executed; new SHA CI pending. Real OpenCode CLI not exercised.
- Concurrency: repository Actions in_progress=0, queued=0 immediately before write; target HEAD matched parent.
- Remaining: verify new Playwright Node 20/22 CI; then implement real Git health status and negative cases. Issue #8 and production #3 remain open; no production merge.

### WB-004 — Invalid Git root browser retry regression (2026-11-20)
- Branch: `feat/WB-004-registration-client-20261120`; parent verified remote SHA `3f628a9ecfd27239198e9689f834ac83984a0edd`.
- Files: `workbench/e2e/project-registration.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: browser regression checks API 400 for a non-Git absolute root is rendered as sanitized feedback without leaking server text; corrected path retries successfully and refreshes the registered list.
- Validation: previous SHA Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44833562838 and Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44833562856 both completed success. New Playwright test NOT executed locally; new SHA CI pending; real OpenCode CLI NOT exercised.
- Concurrency: repository Actions queued=0, in_progress=0 before this change; branch SHA verified. No production operations.
- Risk: mocked HTTP responses are not a real three-repository integration acceptance; Git health UI still missing. Issues #8 and #3 remain open.
- Next: inspect new SHA CI, fix failures first, then wire real HEAD/branch/dirty status into the Web project view with browser regression.

### WB-004 — Align HTTP 400 browser assertion with sanitized client feedback (2026-11-21)
- Branch: `feat/WB-004-registration-client-20261120`; verified parent remote SHA `7bf996e3eab07d8295bf4167663dda0bc5c7a8f8`.
- Files: `workbench/e2e/project-registration.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Acceptance: invalid Git root HTTP 400 displays the actual sanitized client message `仓库路径或登记信息无效`, does not reveal `PRIVATE_SERVER_PATH`, and corrected retry still refreshes the project list. Only the mismatched assertion changed; existing retry and redaction checks retained.
- Evidence: prior Workbench CI https://github.com/hutong236/hulane-opencode/actions/runs/44847096365 failed on old expected wording; prior Hulane CI https://github.com/hutong236/hulane-opencode/actions/runs/44847096379 succeeded. Source-level assertion replacement verified; no local npm/Playwright or real OpenCode CLI execution. New SHA CI must be checked after push.
- Concurrency: repository Actions in_progress=0 and queued=0 from GitHub REST before write; remote target HEAD verified.
- Risk: mock-based Playwright is not real local Git root or production Gate acceptance. Issues #8 and #3 remain open.
- Next: verify exact new SHA Workbench/Hulane CI; if green, implement actual Git HEAD/branch/dirty health status in Web project list with tests.

### WB-004 — Strict persisted-ID Git status Web client (2026-11-22)
- Step / acceptance: Add `getProjectStatus(id, signal)` using only validated UUID paths, strict Git status DTO decoding, sanitized HTTP 404/409, malformed response rejection, and preserved AbortError; add Node regression tests.
- Branch: `feat/WB-004-status-client-20261122`, parent `d062539dd06dd8a958e6f2c60ef81263265a2a99` (stacked on Draft PR #53). Exact remote HEAD after push is authoritative.
- Files: `workbench/apps/web/src/api/client.ts`, `workbench/apps/web/test/project-git-status.spec.ts`, `docs/SESSION_HANDOFF.md`.
- Validation: source-level contract checked against `apps/api/src/app.ts` and `repository-status.ts`; Node/TypeScript/Playwright and real OpenCode CLI not executed in this GitHub API session. New SHA Actions CI pending.
- Safety: GitHub REST Actions collection checked for in_progress/queued jobs before branch update; no production branch write or Gate bypass.
- Next: verify exact SHA Workbench/Hulane CI, fix any failure first; then render HEAD/branch/dirty in ProjectList with browser regression and unavailable-repo retry.
