const { DatabaseSync } = require('node:sqlite')
const a = new DatabaseSync(process.argv[2])
const b = new DatabaseSync(process.argv[2])
a.exec('PRAGMA busy_timeout=0')
b.exec('PRAGMA busy_timeout=0')
a.exec('BEGIN EXCLUSIVE')
try {
  b.exec('BEGIN EXCLUSIVE')
  console.log('same-process: acquired (BAD)')
} catch (e) {
  console.log('same-process busy ok:', e.message)
}
a.exec('COMMIT')
b.exec('BEGIN EXCLUSIVE')
console.log('after commit: b acquired')
