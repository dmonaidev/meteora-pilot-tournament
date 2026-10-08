export const scheduleFields=['registration_start_at','registration_end_at','start_at','end_at'];
export async function readSchedule(client,lock='') {
 const result=await client.query('SELECT registration_start_at,registration_end_at,start_at,end_at FROM tournament_settings WHERE id=1 '+lock);
 if(!result.rows[0])throw new Error('Missing tournament settings');
 return result.rows[0];
}
export function scheduleOutput(row,current) {
 const reached=field=>row[field]!==null&&+current>=+new Date(row[field]);
 const ended=reached('end_at');
 const closed=ended||reached('registration_end_at');
 const upcoming=row.registration_start_at!==null&&+current<+new Date(row.registration_start_at);
 return {...Object.fromEntries(scheduleFields.map(field=>[field,row[field]===null?null:new Date(row[field]).toISOString()])),registration_open:!closed&&!upcoming,registration_status:closed?'CLOSED':upcoming?'UPCOMING':'OPEN',started:reached('start_at'),ended,server_time:current.toISOString()};
}
