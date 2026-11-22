import { DatabaseSync } from 'node:sqlite'

const d = new DatabaseSync('data/chat-demo.db', { readOnly: true })
console.log('--- triggers/indexes ---')
const objects = d
  .prepare(
    "select type, name, tbl_name, sql from sqlite_master where tbl_name in ('sessions','files','staging_sessions','staging_files','messages_fts') and type in ('index','trigger')"
  )
  .all()
for (const r of objects) {
  console.log(r.type, r.name, 'on', r.tbl_name, (r.sql ?? '').slice(0, 140))
}
console.log('--- counts ---')
for (const t of ['sessions', 'files', 'staging_sessions', 'staging_files', 'shares', 'messages_fts']) {
  console.log(t, d.prepare(`select count(*) n from ${t}`).get().n)
}
d.close()
