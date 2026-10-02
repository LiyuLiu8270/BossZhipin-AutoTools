// Derived snapshots only. Detect own writes AND commits from other connections.
export function databaseRevision(db){
 return `${db.prepare('SELECT total_changes() AS n').get().n}:${db.prepare('PRAGMA data_version').get().data_version}`;
}
export function trackReadTables(db,tables){
 db.exec('CREATE TABLE IF NOT EXISTS read_epochs(name TEXT PRIMARY KEY,value INTEGER NOT NULL);');
 for(const table of tables){
  if(!/^[a-z_]+$/.test(table))throw Error('invalid_tracking_table');
  db.prepare('INSERT OR IGNORE INTO read_epochs VALUES(?,0)').run(table);
  for(const event of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS career_epoch_${table}_${event} AFTER ${event} ON ${table} BEGIN UPDATE read_epochs SET value=value+1 WHERE name='${table}'; END;`);
 }
}
export function tableRevision(db,tables){
 return tables.map(name=>db.prepare('SELECT value FROM read_epochs WHERE name=?').get(name)?.value??0).join(':');
}
export function cachedRead(owner,key,identity,build,{ttlMs=Infinity,expiresAt=()=>Infinity,clock=Date.now,tables=null}={}){
 const now=clock(),revision=tables?tableRevision(owner.db,tables):databaseRevision(owner.db),entry=owner._readCache?.get(key);
 if(entry&&entry.revision===revision&&entry.identity===identity&&entry.expires>now)return entry.value;
 const value=build();owner._readCache??=new Map();
 if(owner._readCache.size>=24)owner._readCache.delete(owner._readCache.keys().next().value);
 owner._readCache.set(key,{revision,identity,value,expires:Math.min(now+ttlMs,expiresAt(value))});return value;
}
