import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync, statSync, readdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {jobIdentity, migrateDataset, readableJD} from '../shared/core.js';
import {adaptScraper, mergeScraperJob} from './scraper-adapter.mjs';
import {cachedRead,trackReadTables} from './read-cache.mjs';

// Local data only: no network, browser/profile access, model calls or messages.
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = value => createHash('sha256').update(value).digest('hex');
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export function analysisInput(job) {
  // Observation timestamps / seen_count alone must not spend another model call.
  return Object.fromEntries(['id', 'title', 'company', 'salary', 'location', 'tags', 'benefits', 'jd', 'jd_status', 'jd_truncated'].map(k => [k, job[k] ?? null]).concat([
    ['hiring_type', job.hiring_party?.type || 'unknown'], ['availability', job.recruitment_signals?.availability?.value || 'unknown'],
    ['link_state', job.link_access?.state || 'unknown'], ['detail_review', job.detail_review?.state || 'unknown'],
    ['recruiter_activity', job.recruitment_signals?.recruiter_activity?.raw || []]
  ], ['company_scale', 'company_stage', 'company_industry', 'experience', 'education', 'skills'].filter(k => job[k]?.length).map(k => [k, job[k]])));
}
function readiness(job) {
  if (job.link_access?.state === 'unavailable') return 'link_unavailable';
  if (job.recruitment_signals?.availability?.value === 'explicit_unavailable') return 'closed';
  if (['needs_review', 'retry_ready'].includes(job.detail_review?.state)) return 'jd_review';
  return readableJD(job) ? null : 'jd_not_readable';
}
function validateExport(raw) {
  if (raw.schema_version !== 2 || !Array.isArray(raw.jobs) || !time(raw.exported_at) ||
      typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 40) throw new Error('不是受支持的采集器JSON（需要schema 2、数据集、导出时间和岗位数组）');
  const ids = new Set();
  for (const job of raw.jobs) {
    if (!job || typeof job.title !== 'string' || !job.title.trim() || jobIdentity(job.url)?.id !== job.id || ids.has(job.id)) throw new Error('岗位身份无效/重复，整份文件未导入');
    if (typeof job.jd !== 'string') throw new Error('岗位JD类型无效，整份文件未导入');
    ids.add(job.id);
  }
}
export class IntakeStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA cache_size=-65536;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS intake_imports (hash TEXT PRIMARY KEY, source TEXT NOT NULL, dataset TEXT NOT NULL, exported_at TEXT NOT NULL, imported_at TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_versions (dataset TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, import_hash TEXT NOT NULL, PRIMARY KEY(dataset,id,hash));
      CREATE TABLE IF NOT EXISTS intake_jobs (dataset TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, exported_at TEXT NOT NULL, import_hash TEXT NOT NULL, PRIMARY KEY(dataset,id));
      CREATE TABLE IF NOT EXISTS intake_analysis_queue (dataset TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, PRIMARY KEY(dataset,id));`);
    trackReadTables(this.db,['intake_jobs','intake_analysis_queue','intake_imports']);
  }
  jobsSnapshot(){return cachedRead(this,'jobs','',()=>this.db.prepare('SELECT dataset,id,body FROM intake_jobs').all().map(r=>({dataset:r.dataset,id:r.id,job:JSON.parse(r.body)})),{tables:['intake_jobs']});}
  jobMap(){return cachedRead(this,'job-map','',()=>new Map(this.jobsSnapshot().map(r=>[JSON.stringify([r.dataset,r.id]),r.job])),{tables:['intake_jobs']});}
  get(dataset, id) {
    const row = this.db.prepare('SELECT body FROM intake_jobs WHERE dataset=? AND id=?').get(dataset, id);
    return row ? JSON.parse(row.body) : null;
  }
  importFile(path) {
    const file = resolve(path), size = statSync(file).size;
    if (size > 100 * 1024 * 1024) throw new Error('文件超过100MB，未导入');
    const bytes = readFileSync(file), hash = digest(bytes);
    return this.importPayload(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), file, hash);
  }
  importScraper(input) {
    const payload = adaptScraper(input);
    return this.importPayload(payload, 'scraper:local', digest(canonical(payload)), mergeScraperJob);
  }
  importPayload(raw, file = 'local:import', hash = digest(canonical(raw)), mergeIncoming = null) {
    if (this.db.prepare('SELECT 1 FROM intake_imports WHERE hash=?').get(hash)) return {status: 'already_imported', file};
    validateExport(raw);
    const dataset = raw.label.trim(), importedAt = new Date().toISOString(), at = new Date(raw.exported_at).toISOString();
    const normalized = migrateDataset({...raw, jobs: Object.fromEntries(raw.jobs.map(j => [j.id, j]))});
    const result = {status: 'imported', dataset, source_jobs: raw.jobs.length, added: 0, updated: 0, older_skipped: 0, queued: 0};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck after obtaining the lock: two receiving processes cannot duplicate imports.
      if (this.db.prepare('SELECT 1 FROM intake_imports WHERE hash=?').get(hash)) { this.db.exec('ROLLBACK'); return {status: 'already_imported', file}; }
      const {jobs: unusedJobs, ...metadata} = raw;
      this.db.prepare('INSERT INTO intake_imports VALUES(?,?,?,?,?,?)').run(hash, file, dataset, at, importedAt, JSON.stringify(metadata));
      for (const original of raw.jobs) {
        this.db.prepare('INSERT OR IGNORE INTO intake_versions VALUES(?,?,?,?,?)').run(dataset, original.id, digest(canonical(original)), JSON.stringify(original), hash);
        const row = this.db.prepare('SELECT * FROM intake_jobs WHERE dataset=? AND id=?').get(dataset, original.id);
        if (row && at < row.exported_at) { result.older_skipped++; continue; }
        const incoming = normalized.jobs[original.id], old = row ? JSON.parse(row.body) : null;
        let job = incoming;
        if (old) {
          // Imports are complete stored-record snapshots, not new observations.
          // mergeJob would invent an observation and could resurrect old state.
          job = mergeIncoming ? mergeIncoming(old, incoming) : {...old, ...incoming};
          // This is an export import, NOT a new page observation.
          job.seen_count = Math.max(old.seen_count || 0, job.seen_count || 0);
          job.first_seen_at = [old.first_seen_at, incoming.first_seen_at].filter(time).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || old.first_seen_at;
          job.last_seen_at = [old.last_seen_at, incoming.last_seen_at].filter(time).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || old.last_seen_at;
          if (old.contact_status && old.contact_status !== 'unknown' && (!incoming.contact_status || incoming.contact_status === 'unknown')) job.contact_status = old.contact_status;
          if (canonical(old) !== canonical(job)) result.updated++;
        } else result.added++;
        this.db.prepare('INSERT INTO intake_jobs VALUES(?,?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET body=excluded.body, exported_at=excluded.exported_at, import_hash=excluded.import_hash').run(dataset, job.id, JSON.stringify(job), at, hash);
        const fingerprint = digest(canonical(analysisInput(job))), reason = readiness(job);
        const existing = this.db.prepare('SELECT fingerprint FROM intake_analysis_queue WHERE dataset=? AND id=?').get(dataset, job.id);
        if (existing?.fingerprint !== fingerprint) {
          this.db.prepare('INSERT INTO intake_analysis_queue VALUES(?,?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET fingerprint=excluded.fingerprint,state=excluded.state,reason=excluded.reason').run(dataset, job.id, fingerprint, reason ? 'deferred' : 'pending', reason);
          if (!reason) result.queued++;
        }
      }
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  stats() {
    return this.db.prepare(`SELECT j.dataset, COUNT(*) AS jobs,
      SUM(CASE WHEN q.state='pending' THEN 1 ELSE 0 END) AS pending_analysis,
      SUM(CASE WHEN q.state='deferred' THEN 1 ELSE 0 END) AS deferred
      FROM intake_jobs j LEFT JOIN intake_analysis_queue q ON j.dataset=q.dataset AND j.id=q.id GROUP BY j.dataset`).all();
  }
  close() { this.db.close(); }
}

// Only completed collector JSON downloads, never unrelated Downloads files.
export function captureFiles(folder) {
  return readdirSync(folder, {withFileTypes: true}).filter(e => e.isFile() && /^boss-(?:jobs|capture|new-jobs)-.+\.json$/i.test(e.name))
    .map(e => join(resolve(folder), e.name)).sort();
}
export class IntakeScanner {
  constructor(store, folder) { this.store = store; this.folder = folder; this.seen = new Map(); }
  scan({stable = true} = {}) {
    const results = [], current = new Set(captureFiles(this.folder));
    for (const path of this.seen.keys()) if (!current.has(path)) this.seen.delete(path);
    for (const path of current) {
      try {
        const st = statSync(path), signature = `${st.size}:${st.mtimeMs}`, prior = this.seen.get(path);
        if (prior?.signature !== signature) {
          this.seen.set(path, {signature, finished: false});
          if (stable) continue; // Wait for unchanged size/time on two consecutive polls.
        }
        const entry = this.seen.get(path);
        if (entry.finished) continue;
        const result = this.store.importFile(path); entry.finished = true;
        results.push({file: path, ...result});
      } catch (error) {
        // A broken file cannot stop later files. Retry only after that file changes.
        const entry = this.seen.get(path); if (entry) entry.finished = true;
        results.push({file: path, status: 'error', error: error.message});
      }
    }
    return results;
  }
}
