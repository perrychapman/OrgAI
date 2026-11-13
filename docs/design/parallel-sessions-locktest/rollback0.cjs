// Take and release an exclusive and a shared lock with ROLLBACK; the file must stay 0 bytes.
const { DatabaseSync } = require('node:sqlite')
const { statSync, existsSync } = require('node:fs')
const file = process.argv[2]
const db = new DatabaseSync(file)
db.exec('PRAGMA busy_timeout=0')
db.exec('BEGIN EXCLUSIVE')
db.exec('ROLLBACK')
db.exec('BEGIN')
db.prepare('SELECT count(*) FROM sqlite_schema').get()
db.exec('ROLLBACK')
db.close()
console.log('size', statSync(file).size, 'journal', existsSync(file + '-journal'), 'wal', existsSync(file + '-wal'))
