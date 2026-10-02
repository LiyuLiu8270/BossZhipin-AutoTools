import {jobIdentity, clean} from './core.js';
import {compareTitles} from './text-rules.js';

export function validateIdentity(capture, expected) {
  if (jobIdentity(capture.source_url)?.id !== expected.id) throw new Error('实际页面与目标岗位 ID 不一致，未保存。');
  if (!['captured', 'job_unavailable'].includes(capture.status)) return;
  if (capture.jobs?.length !== 1 || jobIdentity(capture.jobs[0].url)?.id !== expected.id) throw new Error('详情身份不明确，未保存。');
  const match = compareTitles(expected.title, capture.jobs[0].title);
  if (!(capture.status === 'job_unavailable' && !capture.jobs[0].title) && match.kind === 'conflict') {
    const error = new Error('岗位名称变化或读取不一致，未覆盖原记录，请人工核对。');
    // Only emitted after URL ID, record ID and single-record checks passed.
    error.code = 'same_id_title_conflict';
    error.evidence = {expected_id: expected.id, observed_id: jobIdentity(capture.jobs[0].url).id,
      expected_title: clean(expected.title).slice(0, 300), observed_title: clean(capture.jobs[0].title).slice(0, 300)};
    throw error;
  }
  return match;
}
