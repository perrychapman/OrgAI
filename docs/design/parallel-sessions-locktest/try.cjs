const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[2]); db.exec('PRAGMA busy_timeout=0')
try { db.exec('BEGIN EXCLUSIVE'); console.log('acquired'); db.exec('COMMIT') } catch (e) { console.log('busy:', e.message, e.errcode) }
