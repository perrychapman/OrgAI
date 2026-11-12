# OS lock checks for parallel-sessions.md 4.1

Run by hand on 2026-11-11 (Node 26; `try.cjs` also under Electron 45's Node 24.22 with `ELECTRON_RUN_AS_NODE=1`).

- `node hold.cjs l.db &` then `node try.cjs l.db` prints `busy: database is locked`; after `kill -9` of the holder,
  `node try.cjs l.db` prints `acquired`.
- `node same.cjs l3.db`: a second connection in the same process is refused, and acquires after the first commits.
- `node shared.cjs s.db shared &` twice: both hold; `node shared.cjs s.db excl` is refused; after `kill -9` of both,
  it acquires.
- 2026-11-12, 0-byte files (no table, nothing ever written): `node shared0.cjs z.db shared &` twice: both hold;
  `node shared0.cjs z.db excl` is refused; `node probe0.cjs z.db` with an exclusive holder (`hold.cjs`) reports
  `database is locked` for `sqlite_schema` and `PRAGMA schema_version` reads (a table read fails "no such table");
  after `kill -9` the exclusive acquire succeeds.
- `node rollback0.cjs r.db`: exclusive then shared, each released with ROLLBACK: the file stays 0 bytes with no
  `-journal` or `-wal`. (Released with COMMIT, the file grows to 4096 bytes.)
- macOS 26: `ps -E` / `ps eww` do not show another process's environment; `lsof -a -p <pid> -d cwd -Fn` shows its cwd.
