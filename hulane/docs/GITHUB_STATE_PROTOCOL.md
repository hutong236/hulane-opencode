# GitHub state protocol

GitHub is the durable source of truth. `.hulane/state.json` is a local cache
and Obsidian is a read-only projection.

Each managed Issue has exactly one state label and one machine state comment:

```text
hulane:waiting-approval
hulane:doing
hulane:testing
hulane:review
hulane:pr-checking
hulane:waiting-human-merge
hulane:waiting-tag-confirm
hulane:building
hulane:blocked
hulane:done
```

The state comment starts with this marker:

```text
<!-- cmdb-dev-state:v2 -->
```

and contains one fenced `cmdb-state` JSON document conforming to
`schemas/work-item-state.schema.json`. The `hulane-control` MCP server updates the
latest managed comment after every verified transition. Human approvals are history events
whose actor is recorded as `human:<identity>`.

Every payload carries a monotonically increasing `revision`. Sync fails closed
when GitHub already has a newer revision or the same revision with divergent
content; the caller must hydrate and reconcile instead of overwriting remote
truth. Older V1.2 comments are normalized with additive V1.3/V1.4 defaults
before validation.

### Sync fast path

`.hulane/github-meta.json` is a non-canonical accelerator next to the state
cache. It records, per Work Item, the managed comment id and the last-synced
state label. After the first successful sync (or hydrate) of an item, subsequent
syncs take a steady-state path of at most two `gh` calls — one label edit when
the status label changed and one comment PATCH — with no comment listing.

The fast path relies on single-writer orchestration: only the Primary Agent
mutates a Work Item, so the local revision is authoritative between sessions
that hydrate. The conservative full path still runs on first sync, when the
meta file is missing, or when the cached comment id 404s (comment deleted or
issue recreated); it lists managed comments, asserts the remote revision guard
described above, cleans stray `hulane:*` labels, and repopulates the meta entry.
Deleting the meta file is always safe — it only costs the next sync a full
round trip.

Historical `done` records that predate the V2 evidence fields are marked
`legacy_completion: true` during normalization. They remain readable and are
never upgraded into fabricated V2 evidence; every newly created Work Item uses
`legacy_completion: false` and the full current Done invariant.

Recovery order:

1. Read the GitHub Issue, state label and machine comment.
2. Reconcile PR/checks/merge/Actions facts into that state.
3. Hydrate `.hulane/state.json` as a cache.
4. Regenerate the Obsidian projection.

Deleting the local cache must never lose approvals, risk, delivery policy,
test/review evidence, merged SHA, Tag decision or image Digest.
