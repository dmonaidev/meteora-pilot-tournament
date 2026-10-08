import {randomUUID} from 'node:crypto';
import {z} from 'zod';
const rulesLock=712037462;
export const lockRules=client=>client.query('SELECT pg_advisory_xact_lock_shared($1)',[rulesLock]);
export async function requireActiveRules(client,id,ApiError){
 const active=(await client.query("SELECT id FROM tournament_rules WHERE status='ACTIVE' AND deleted_at IS NULL")).rows[0];
 if(!active)throw new ApiError(409,'RULES_UNAVAILABLE');
 if(active.id!==id)throw new ApiError(409,'RULES_CHANGED');
}
export async function requirePendingConsent(client,pending,ApiError){
 if(!pending.rules_version_id||!pending.rules_accepted_at)throw new ApiError(409,'RULES_CHANGED');
 const accepted=(await client.query("SELECT id FROM tournament_rules WHERE id=$1 AND status IN ('ACTIVE','ARCHIVED') AND published_at IS NOT NULL AND deleted_at IS NULL",[pending.rules_version_id])).rowCount;
 if(!accepted)throw new ApiError(409,'RULES_CHANGED');
}
const summary=row=>({id:row.id,version:row.version,title:row.title,status:row.status,created_at:new Date(row.created_at).toISOString(),published_at:row.published_at?new Date(row.published_at).toISOString():null,archived_at:row.archived_at?new Date(row.archived_at).toISOString():null});
const output=row=>({...summary(row),body:row.body});
export function registerRules({route,admin,pool,clock,tx,parse,ApiError}){
 const content=z.object({title:z.string().trim().min(1).max(150),body:z.string().trim().min(1).max(100000)}).strict();
 const id=req=>parse(z.string().uuid(),req.params.id);
 const mutation=async fn=>tx(async client=>{await client.query('SELECT pg_advisory_xact_lock($1)',[rulesLock]);return fn(client);});
 const find=async(client,value)=>{const row=(await client.query('SELECT * FROM tournament_rules WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[value])).rows[0];if(!row)throw new ApiError(404,'RULES_NOT_FOUND');return row;};
 route('GET','/public/rules',async()=>{const versions=(await pool.query("SELECT * FROM tournament_rules WHERE status IN ('ACTIVE','ARCHIVED') AND published_at IS NOT NULL AND deleted_at IS NULL ORDER BY version DESC")).rows;return {active:versions.some(row=>row.status==='ACTIVE')?output(versions.find(row=>row.status==='ACTIVE')):null,versions:versions.map(summary)};});
 route('GET','/public/rules/:id',async req=>{const row=(await pool.query("SELECT * FROM tournament_rules WHERE id=$1 AND status IN ('ACTIVE','ARCHIVED') AND published_at IS NOT NULL AND deleted_at IS NULL",[id(req)])).rows[0];if(!row)throw new ApiError(404,'RULES_NOT_FOUND');return output(row);});
 route('GET','/admin/rules',async()=>{const versions=(await pool.query('SELECT * FROM tournament_rules WHERE deleted_at IS NULL ORDER BY version DESC')).rows;return {active_version_id:versions.find(row=>row.status==='ACTIVE')?.id??null,versions:versions.map(output)};},admin);
 route('POST','/admin/rules',async(req,reply)=>{const body=parse(content,req.body);const result=await mutation(async client=>output((await client.query("INSERT INTO tournament_rules(id,title,body,status,created_at) VALUES($1,$2,$3,'DRAFT',$4) RETURNING *",[randomUUID(),body.title,body.body,clock()])).rows[0]));return reply.code(201).send(result);},admin);
 route('POST','/admin/rules/:id/save',async req=>{const value=id(req),body=parse(content,req.body);return mutation(async client=>{const row=await find(client,value);if(row.status!=='DRAFT')throw new ApiError(409,'RULES_VERSION_LOCKED');return output((await client.query('UPDATE tournament_rules SET title=$2,body=$3 WHERE id=$1 RETURNING *',[value,body.title,body.body])).rows[0]);});},admin);
 route('POST','/admin/rules/:id/publish',async req=>{const value=id(req);parse(z.object({}).strict(),req.body);return mutation(async client=>{const row=await find(client,value);if(row.status==='ACTIVE')return output(row);if(row.status!=='DRAFT')throw new ApiError(409,'RULES_VERSION_LOCKED');const current=clock();await client.query("UPDATE tournament_rules SET status='ARCHIVED',archived_at=$1 WHERE status='ACTIVE' AND deleted_at IS NULL",[current]);return output((await client.query("UPDATE tournament_rules SET status='ACTIVE',published_at=$2 WHERE id=$1 RETURNING *",[value,current])).rows[0]);});},admin);
 route('POST','/admin/rules/:id/delete',async req=>{const value=id(req);parse(z.object({}).strict(),req.body);return mutation(async client=>{const row=await find(client,value);if(row.status==='ACTIVE')throw new ApiError(409,'RULES_ACTIVE_DELETE_FORBIDDEN');await client.query('UPDATE tournament_rules SET body=NULL,deleted_at=$2 WHERE id=$1',[value,clock()]);return {status:'deleted'};});},admin);
}
