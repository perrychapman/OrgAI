# OS lock checks for parallel-sessions.md 4.1

Run by hand on 2026-11-11 (Node 26; `try.cjs` also under Electron 45's Node 24.22 with `ELECTRON_RUN_AS_NODE=1`).

- `node hold.cjs l.db &` then `node try.cjs l.db` prints `busy: database is locked`; after `kill -9` of the holder,
  `node try.cjs l.db` prints `acquired`.
- `node same.cjs l3.db`: a second connection in the same process is refused, and acquires after the first commits.
- `node shared.cjs s.db shared &` twice: both hold; `node shared.cjs s.db excl` is refused; after `kill -9` of both,
  it acquires.
