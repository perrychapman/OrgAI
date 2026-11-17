// Like shared.cjs but never writes: shared = BEGIN + read of sqlite_schema, so a 0-byte file stays 0 bytes.
const { DatabaseSync } = require('node:sqlite')
const [file, mode] = process.argv.slice(2)
const db = new DatabaseSync(file)
db.exec('PRAGMA busy_timeout=0')
try {
  if (mode === 'shared' || mode === 'shared-try') {
    db.exec('BEGIN')
    db.prepare('SELECT count(*) FROM sqlite_schema').get()
    console.log(mode, 'ok', process.pid)
    if (mode === 'shared') setInterval(() => {}, 1000)
    else db.exec('COMMIT')
  } else {
    db.exec('BEGIN EXCLUSIVE')
    console.log('excl acquired')
    db.exec('COMMIT')
  }
} catch (e) {
  console.log(mode, 'busy:', e.message)
}
