import { lockRules, requirePendingConsent } from './rules.mjs';
import { readSchedule, scheduleOutput } from './schedule.mjs';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { createTelegramTransport } from '../bot/telegram-transport.mjs';

const message='Код неверен или истёк. Отправьте /start боту для нового кода';
const digest=(secret,token,tgId,code)=>createHmac('sha256',secret).update(JSON.stringify(['telegram-otp-v1',token,String(tgId),code])).digest('hex');
const sameHash=(expected,actual)=>{
 const left=Buffer.from(expected||'','hex'),right=Buffer.from(actual,'hex');
 return left.length===right.length&&timingSafeEqual(left,right);
};

export function registerTelegramCode({route,pool,config,clock,tx,parse,ApiError,tg,username,tokenSchema,accessSessions}) {
 const invalid=()=>new ApiError(422,'CODE_INVALID',message);
 const transport=createTelegramTransport(config);
 const issueCode=async(client,id,name)=>{
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[id]);
  const current=clock();
  const last=(await client.query('SELECT max(created_at) issued_at FROM pending_sessions WHERE otp_tg_id=$1',[id])).rows[0].issued_at;
  const remaining=last?Math.ceil((90000-(+current-+new Date(last)))/1000):0;
  if(remaining>0)return {cooldown:Math.min(remaining,90)};
  const code=String(randomInt(0,1000000)).padStart(6,'0');
  const token='otp_'+randomBytes(32).toString('base64url');
  await client.query('UPDATE pending_sessions SET otp_code_hash=NULL WHERE otp_tg_id=$1 AND otp_code_hash IS NOT NULL',[id]);
  await client.query("INSERT INTO pending_sessions(token,session_type,display_name,created_at,otp_tg_id,otp_tg_username,otp_code_hash) VALUES($1,'AUTHORIZATION',NULL,$2,$3,$4,$5)",[token,current,id,name,digest(config.jwtSecret,token,id,code)]);
  return {code,created:current};
 };
 const findGrant=async(client,identifier,lock=false)=>{
  const numeric=/^[0-9]+$/.test(identifier);
  if(numeric&&(!Number.isSafeInteger(Number(identifier))||Number(identifier)<=0))return null;
  const condition=numeric?'otp_tg_id=$1':'lower(otp_tg_username)=lower($1)';
  const value=numeric?Number(identifier):identifier.replace(/^@/,'');
  return (await client.query('SELECT * FROM pending_sessions WHERE otp_code_hash IS NOT NULL AND '+condition+' ORDER BY created_at DESC,token ASC LIMIT 1'+(lock?' FOR UPDATE':''),[value])).rows[0]??null;
 };
 route('POST','/bot/code',async(req)=>{
  const supplied=Buffer.from(req.headers['x-bot-secret']||''),expected=Buffer.from(config.botApiSecret);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new ApiError(401,'UNAUTHORIZED');
  const body=parse(z.object({tg_id:tg,tg_username:username}).strict(),req.body);
  const issued=await tx(client=>issueCode(client,body.tg_id,body.tg_username));
  if(issued.cooldown){const error=new ApiError(429,'CODE_COOLDOWN','Подождите перед запросом нового кода');error.retry_after_seconds=issued.cooldown;throw error;}
  return {code:issued.code,expires_at:new Date(+issued.created+300000).toISOString(),telegram_identifier:body.tg_username?'@'+body.tg_username:String(body.tg_id)};
 });
 route('POST','/auth/code/request',async(req)=>{
  const body=parse(z.object({token:tokenSchema,telegram_identifier:z.string().trim().min(1).max(255)}).strict(),req.body);
  const delivery=await tx(async client=>{
   const website=(await client.query('SELECT * FROM pending_sessions WHERE token=$1 FOR UPDATE',[body.token])).rows[0];
   if(!website)throw new ApiError(404,'SESSION_NOT_FOUND');
   if(+clock()>=+new Date(website.created_at)+900000)throw new ApiError(410,'SESSION_EXPIRED');
   if(website.is_used)throw new ApiError(409,'SESSION_ALREADY_BOUND');
   const numeric=/^[0-9]+$/.test(body.telegram_identifier);
   if(numeric&&(!Number.isSafeInteger(Number(body.telegram_identifier))||Number(body.telegram_identifier)<=0))return null;
   const identifier=numeric?Number(body.telegram_identifier):body.telegram_identifier.replace(/^@/,'');
   if(!numeric&&website.expected_tg_username&&website.expected_tg_username.toLowerCase()!==String(identifier).toLowerCase())return null;
   const candidates=(await client.query('SELECT tg_id,tg_username,display_name FROM users WHERE '+(numeric?'tg_id=$1':'lower(tg_username)=lower($1)')+' ORDER BY id LIMIT 2',[identifier])).rows;
   if(candidates.length!==1)return null;
   const user=candidates[0];
   if(Number(user.tg_id)===800000000000026)return null;
   if(website.expected_tg_username&&website.expected_tg_username.toLowerCase()!==user.tg_username?.toLowerCase())return null;
   const issued=await issueCode(client,user.tg_id,user.tg_username);
   return issued.code?{...issued,tgId:Number(user.tg_id)}:null;
  });
  if(delivery){
   try{await transport({chat_id:delivery.tgId,text:`Код для входа: ${delivery.code}\nMeteora $MET Tournament. Действует 5 минут. Введите его в исходной вкладке сайта. Никому не сообщайте код.`});}
   catch{/* Delivery failures keep the neutral response and manual /start fallback. */}
  }
  return {status:'requested',retry_after_seconds:90};
 });
 route('POST','/auth/code/verify',async(req)=>{
  const body=parse(z.object({token:tokenSchema,telegram_identifier:z.string().trim().min(1).max(255),code:z.string().regex(/^\d{6}$/)}).strict(),req.body);
  const result=await tx(async client=>{
   const schedule=await readSchedule(client,'FOR SHARE');
   await lockRules(client);
   const website=(await client.query('SELECT * FROM pending_sessions WHERE token=$1 FOR UPDATE',[body.token])).rows[0];
   if(!website)throw new ApiError(404,'SESSION_NOT_FOUND');
   if(+clock()>=+new Date(website.created_at)+900000)throw new ApiError(410,'SESSION_EXPIRED');
   if(website.is_used)return {invalid:true};
   const candidate=await findGrant(client,body.telegram_identifier);
   if(!candidate)return {invalid:true};
   await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[candidate.otp_tg_id]);
   // Issuance may have replaced the candidate while this request waited.
   const grant=await findGrant(client,body.telegram_identifier,true);
   if(!grant||String(grant.otp_tg_id)!==String(candidate.otp_tg_id)||grant.is_used||grant.otp_attempts>=5||+clock()>=+new Date(grant.created_at)+300000)return {invalid:true};
   const matches=sameHash(grant.otp_code_hash,digest(config.jwtSecret,grant.token,grant.otp_tg_id,body.code));
   const expectedMatches=!website.expected_tg_username||website.expected_tg_username.toLowerCase()===grant.otp_tg_username?.toLowerCase();
   if(!matches||!expectedMatches){await client.query('UPDATE pending_sessions SET otp_attempts=otp_attempts+1 WHERE token=$1',[grant.token]);return {invalid:true};}
   let inserted=false;
   if(website.session_type==='REGISTRATION'){
    if(!(await client.query('SELECT id FROM users WHERE tg_id=$1',[grant.otp_tg_id])).rowCount){if(!scheduleOutput(schedule,clock()).registration_open)throw new ApiError(409,'REGISTRATION_NOT_OPEN');await requirePendingConsent(client,website,ApiError);}
    const created=await client.query("INSERT INTO users(id,tg_id,tg_username,display_name,registration_status,accepted_rules_version_id,rules_accepted_at) SELECT $1,$2,$3,$4,CASE WHEN EXISTS(SELECT 1 FROM initial_users WHERE tg_id=$2) THEN 'APPROVED_AUTO'::registration_status ELSE 'PENDING_VALIDATION'::registration_status END,$5,$6 ON CONFLICT(tg_id) DO NOTHING",[randomUUID(),grant.otp_tg_id,grant.otp_tg_username,website.display_name,website.rules_version_id,website.rules_accepted_at]);
    inserted=created.rowCount===1;
   }
   const user=(await client.query('SELECT * FROM users WHERE tg_id=$1 FOR UPDATE',[grant.otp_tg_id])).rows[0];
   if(!user)throw new ApiError(404,'USER_NOT_REGISTERED');
   await client.query('UPDATE users SET tg_username=$2 WHERE id=$1',[user.id,grant.otp_tg_username]);
   await client.query('UPDATE pending_sessions SET is_used=true,tg_id=$2 WHERE token=$1',[website.token,user.tg_id]);
   await client.query('UPDATE pending_sessions SET is_used=true,tg_id=$2,otp_code_hash=NULL WHERE token=$1',[grant.token,user.tg_id]);
   if(inserted)client.tournamentEvent={type:'registration',userId:user.id,tgId:Number(user.tg_id)};
   return {session:await accessSessions.linkPending(client,website,user.id),status:user.registration_status};
  },req);
  if(result.invalid)throw invalid();
  const access_token=await accessSessions.sign(result.session);
  return {is_used:true,access_token,token_type:'Bearer',registration_status:result.status};
 });
}
