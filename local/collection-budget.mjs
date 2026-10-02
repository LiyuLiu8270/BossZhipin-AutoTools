import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export const detailGates=new Set(['verification_required','login_required','detail_page_changed','search_page_changed','browser_unavailable']);
export const collectionDay=time=>new Date(time+8*3600000).toISOString().slice(0,10);

// One ledger for all datasets and all collector detail/backfill entry points.
export class CollectionBudget {
  constructor(db,{dataDir,now=()=>Date.now()}){
    Object.assign(this,{db,now});
    db.exec('CREATE TABLE IF NOT EXISTS collection_daily_usage(day TEXT PRIMARY KEY,used INTEGER NOT NULL CHECK(used>=0));');
    if(db.prepare("SELECT value FROM collection_config WHERE key='daily_budget_migrated'").get())return;
    const counts=new Map();const add=(time,n)=>{if(n>0&&Number.isFinite(time)){const day=collectionDay(time);counts.set(day,(counts.get(day)||0)+n);}};
    for(const row of db.prepare('SELECT body FROM collection_runs').all()){
      const run=JSON.parse(row.body),total=(run.details||0)+(run.failedDetails||0);
      let observed=0;
      // Legacy aggregate counters cross midnight: use timestamped per-item evidence first.
      if(/^[a-zA-Z0-9_-]+$/.test(run.id)){
        const file=join(dataDir,'collection',run.id,'task-debug.jsonl');
        if(existsSync(file))for(const line of readFileSync(file,'utf8').split('\n')){
          try{const e=JSON.parse(line);if(e.event==='detail_result'&&!detailGates.has(e.error)&&Number.isFinite(Date.parse(e.at))){add(Date.parse(e.at),1);observed++;}}catch{}
        }
      }
      // Older backfills have no item timestamps. Keep usage conservatively on their last known day.
      add(run.finishedAt||run.lastResumedAt||run.startedAt,Math.max(0,total-observed));
    }
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const [day,used] of counts)db.prepare('INSERT INTO collection_daily_usage VALUES(?,?) ON CONFLICT(day) DO UPDATE SET used=used+excluded.used').run(day,used);
      db.prepare("INSERT INTO collection_config VALUES('daily_budget_migrated','1')").run();db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  status(limit){const day=collectionDay(this.now()),used=this.db.prepare('SELECT used FROM collection_daily_usage WHERE day=?').get(day)?.used||0;return {day,timezone:'Asia/Shanghai',used,limit,remaining:Math.max(0,limit-used)};}
  reserve(limit){
    const day=collectionDay(this.now());
    const row=this.db.prepare('INSERT INTO collection_daily_usage(day,used) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<? RETURNING day').get(day,limit);
    if(!row)throw new Error('detail_daily_limit');return day;
  }
  refund(day){this.db.prepare('UPDATE collection_daily_usage SET used=MAX(0,used-1) WHERE day=?').run(day);}
}
