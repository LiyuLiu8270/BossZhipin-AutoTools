// Read-only UI groups. They never authorize messages or change job records.
export function jobViewFlags(row, communication) {
  const active=row.stage!=='ignored'&&row.reply_status!=='closed';
  return {
    recommended:active&&row.job_state==='unknown'&&row.contact_status!=='contacted'&&
      !['queued','watching','unknown'].includes(communication?.status)&&['优先沟通','可以尝试'].includes(row.result?.priority),
    attention:!!(communication?.unread||communication?.status==='unknown'),
    communicating:active&&(row.contact_status==='contacted'||['queued','watching','unknown'].includes(communication?.status)),
    all:true,
  };
}
