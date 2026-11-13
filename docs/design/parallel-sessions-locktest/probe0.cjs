// Probe a lock file read-only with several queries; report BUSY vs ok vs error.
const { DatabaseSync } = require('node:sqlite')
const file = process.argv[2]
for (const q of ['SELECT count(*) FROM sqlite_schema', 'PRAGMA schema_version', 'SELECT count(*) FROM lock']) {
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA busy_timeout=0')
    db.exec('BEGIN')
    db.prepare(q).get()
    db.exec('COMMIT')
    db.close()
    console.log(q, '=> ok (free)')
  } catch (e) {
    console.log(q, '=>', e.message)
  }
}
