// mode=shared: hold a SHARED lock for the process lifetime. mode=excl: try EXCLUSIVE once. mode=shared-try: try SHARED once.
const { DatabaseSync } = require('node:sqlite')
const [file, mode] = process.argv.slice(2)
const db = new DatabaseSync(file)
db.exec('PRAGMA busy_timeout=0')
db.exec('CREATE TABLE IF NOT EXISTS t(x)')
try {
  if (mode === 'shared' || mode === 'shared-try') {
    db.exec('BEGIN')
    db.prepare('SELECT count(*) FROM t').get()
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
