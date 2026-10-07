import test from 'node:test';
import assert from 'node:assert/strict';
import {jobViewFlags} from '../shared/job-views.mjs';
const row={stage:'new',reply_status:'unknown',job_state:'unknown',contact_status:'unknown',result:{priority:'可以尝试'}};
test('值得沟通是未联系的两档建议，排除终止、忽略和运行中沟通',()=>{
  assert.equal(jobViewFlags(row).recommended,true);
  for(const patch of [{stage:'ignored'},{reply_status:'closed'},{job_state:'closed'},{job_state:'unavailable'},{contact_status:'contacted'},{result:null},{result:{priority:'低优先级'}}])assert.equal(jobViewFlags({...row,...patch}).recommended,false);
  for(const status of ['queued','watching','unknown'])assert.equal(jobViewFlags(row,{status}).recommended,false);
});
test('待办只按未读提醒或未知发送判断，不把所有已回复或待回复作为未读',()=>{
  assert.equal(jobViewFlags({...row,reply_status:'waiting',contact_status:'contacted'}).attention,false);
  assert.equal(jobViewFlags({...row,reply_status:'replied',contact_status:'contacted'},{unread:0,status:'paused'}).attention,false);
  assert.equal(jobViewFlags({...row,stage:'ignored'},{unread:1}).attention,true);
  assert.equal(jobViewFlags(row,{unread:0,status:'unknown'}).attention,true);
});
test('沟通中包括已授权未发送，不包含已结束；视图不修改输入',()=>{
  const before=JSON.stringify(row);assert.equal(jobViewFlags(row,{status:'queued'}).communicating,true);
  assert.equal(jobViewFlags({...row,reply_status:'closed'},{status:'watching'}).communicating,false);
  assert.equal(jobViewFlags(row).all,true);assert.equal(JSON.stringify(row),before);
});
