# Storage

Tanpin persists one inventory document: products, suppliers, purchase orders, stock movements, settings, and a handful of operational logs. The public API is `Store` in `src/engine/store.js` — `load`, `save`, `mutate`, `refresh`, `reset`, `list`, `find`, `insert`, `update`, `remove`, plus `store.data` for in-place edits that you then `save()`.

## Default: SQLite

On Node 22+, `node:sqlite` is available and is the default backend (`src/engine/store-sqlite.js`).

- WAL journal mode, so a reader and a writer can share the file.
- `PRAGMA synchronous = FULL` so each committed transaction is fsync'd.
- One `BEGIN IMMEDIATE` transaction per `save` / `insert` / `update` / `remove` / `reset` / `mutate`. Concurrent writers queue on the write lock instead of silently overwriting each other.
- **Incremental writes.** Each document is one row. A save compares memory with what it last read or wrote and upserts/deletes only the rows that changed; append-only logs (movements, daemon/webhook logs, outbox) are compared by id, never re-serialized. A sale on a store with 100k movements writes the product row and one movement row.
- **Other processes.** `PRAGMA data_version` tells a connection whether anyone else committed. If so, the save re-reads and 3-way merges (snapshot = last read, mine, theirs) before writing: inserts from either process are kept; two processes updating different fields on the same product, or different settings keys, both keep their writes; a delete sticks unless the other process also edited that row; rows added to newest-first logs by the other process sort by time, not to the end.
- **`mutate(fn)`** runs `fn(data)` against the freshest state *inside* the write lock. Stock changes (sales, adjustments, receipts) and PO status transitions go through it, so a stale in-memory copy can never write back an old absolute stock level — a sale is applied as `stock − qty` to the row as it is now.
- **`refresh()`** pulls in another process's commits in place (object identity kept) and costs one PRAGMA when nothing changed. The server calls it at the start of every API request; the daemon at every tick.

The HTTP server and a standalone `tanpin daemon` are the two-process case this is built for. Opening two `Store` instances on the same file in one process is also safe.

`node:sqlite` is still experimental in Node 22. Tanpin suppresses that module's `ExperimentalWarning` at require time; the API can still change in a future Node release.

## File layout

`TANPIN_DB` (or `TANPIN_DATA_DIR/inventory.json`) is still the path you pass into `new Store(file)`. `INVENTORY_DB` is a legacy alias: if the caller passes the default `data/inventory.json` path and `INVENTORY_DB` is set, the store uses that file so older scripts and the test suite keep working. When the SQLite backend is active the durable file is the same path with a `.sqlite` suffix:

| you pass | SQLite writes |
| --- | --- |
| `data/inventory.json` | `data/inventory.sqlite` |
| `data/inventory.sqlite` | `data/inventory.sqlite` |

WAL leaves `*.sqlite-wal` and `*.sqlite-shm` next to the database while a connection is open. Those are runtime files; they are gitignored.

## One-time JSON migration

If the SQLite file is missing or empty and a companion `.json` file already exists, the first `load()` imports that JSON document into SQLite and then uses SQLite only. The JSON file is not deleted. Later loads never re-import, even if the JSON file is still sitting there.

This is the upgrade path from the original whole-file JSON store.

## Movement history retention

Settings key: `movementRetentionDays` (default `365`).

- `365` — drop movements whose `at` (or `createdAt`) is older than 365 days, on load and on save.
- `0` — keep every movement forever.

Forecasts only need recent sales, but a store that never prunes will grow without bound. Set this from `PUT /api/settings` or by editing `store.data.settings` before `save()`.

## JSON fallback

Used when `node:sqlite` cannot be loaded, or when `TANPIN_STORE=json` (or `file`) is set.

The JSON backend writes the whole document to a temp file, `fsync`s, then `rename`s over the destination. That rename is atomic on POSIX, but it is still last-write-wins: if the server and the daemon both `load`, mutate, and `save`, one of those saves replaces the other's. Prefer SQLite whenever two processes share a data directory.

## Choosing a backend

```
TANPIN_STORE=json    # force the JSON file store
TANPIN_STORE=sqlite  # default when node:sqlite loads (any other value is ignored)
```

`require('./engine/store')` exports `Store` (the active backend), `JsonStore` (always the JSON implementation), `newId`, and `DEFAULT_DATA`.
