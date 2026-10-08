import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { compactVerify, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { createTelegramTransport, createTelegramEditor } from '../bot/telegram-transport.mjs';

export async function runRenewalCleanup(pool,config,clock=()=>new Date()) {
 const editor=createTelegramEditor(config),current=clock();
 const result=await pool.query(`UPDATE auth_sessions a SET renewal_token=NULL,renewal_expires_at=NULL FROM users u
  WHERE u.id=a.user_id AND a.renewal_message_id IS NOT NULL AND
  (a.revoked_at IS NOT NULL OR a.renewal_expires_at IS NULL OR a.renewal_expires_at <= $1 OR a.expires_at <= $1)
  RETURNING a.id,a.renewal_message_id,u.tg_id`,[current]);
 for(const row of result.rows){let edited;try{edited=await editor({chat_id:Number(row.tg_id),message_id:Number(row.renewal_message_id)});}catch{}
  if(edited?.ok)await pool.query('UPDATE auth_sessions SET renewal_message_id=NULL WHERE id=$1 AND renewal_message_id=$2',[row.id,row.renewal_message_id]);
 }
}
export function startRenewalCleanup(app,pool,config,clock=()=>new Date()) {
 let timer,running=false,closed=false;
 const tick=async()=>{if(running||closed)return;running=true;try{await runRenewalCleanup(pool,config,clock);}catch{}finally{running=false;}};
 app.addHook('onReady',async()=>{timer=setInterval(()=>{void tick();},15000);timer.unref();});
 app.addHook('onClose',async()=>{closed=true;clearInterval(timer);});
}

export function createAccessSessions({pool,config,clock,tx,parse,ApiError}) {
 const key=new TextEncoder().encode(config.jwtSecret);
 const ttl=Math.min(config.authJwtTtlSeconds||1800,1800);
 const transport=createTelegramTransport(config);
 const editor=createTelegramEditor(config);
 const unauthorized=()=>{throw new ApiError(401,'UNAUTHORIZED');};
 const active=session=>session&&!session.revoked_at&&+clock()<+new Date(session.expires_at);
 const sign=async(session,userId=session.user_id)=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setJti(session.id).setIssuedAt(Math.ceil(+new Date(session.expires_at)/1000)-1800).setExpirationTime(Math.ceil(+new Date(session.expires_at)/1000)).sign(key);
 const linkPending=async(client,pending,userId)=>{
  if(pending.auth_session_id){const session=(await client.query('SELECT * FROM auth_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[pending.auth_session_id,userId])).rows[0];if(!active(session))unauthorized();return session;}
  const session=(await client.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,$3) RETURNING *',[randomUUID(),userId,new Date((Math.floor(+clock()/1000)+ttl)*1000)])).rows[0];
  await client.query('UPDATE pending_sessions SET auth_session_id=$2 WHERE token=$1',[pending.token,session.id]);return session;
 };
 const authenticate=async(req,allowExpired=false)=>{
  const header=req.headers.authorization;if(!header?.startsWith('Bearer '))unauthorized();const token=header.slice(7);let payload;
  try{({payload}=await jwtVerify(token,key,{algorithms:['HS256'],currentDate:clock()}));}
  catch(error){if(!allowExpired||error.code!=='ERR_JWT_EXPIRED')unauthorized();try{payload=JSON.parse(new TextDecoder().decode((await compactVerify(token,key,{algorithms:['HS256']})).payload));}catch{unauthorized();}}
  const current=Math.floor(+clock()/1000);
  if(!z.string().uuid().safeParse(payload.sub).success||!Number.isSafeInteger(payload.iat)||payload.iat>current||!Number.isSafeInteger(payload.exp)||payload.exp<=payload.iat||(payload.nbf!==undefined&&(!Number.isFinite(payload.nbf)||payload.nbf>current)))unauthorized();
  const legacy=payload.jti===undefined;
  if(!legacy&&!z.string().uuid().safeParse(payload.jti).success)unauthorized();
  const legacyDeadline=Math.min(payload.exp,payload.iat+1800)*1000;
  const fingerprint=legacy?createHash('sha256').update(token).digest('hex'):null;
  if(legacy&&!allowExpired&&+clock()>=legacyDeadline)unauthorized();
  if(legacy){
   const existing=(await pool.query('SELECT id FROM auth_sessions WHERE legacy_token_hash=$1 AND user_id=$2',[fingerprint,payload.sub])).rows[0];
   if(!existing){if(+clock()>=legacyDeadline)unauthorized();await pool.query('INSERT INTO auth_sessions(id,user_id,expires_at,legacy_token_hash) SELECT $1,id,$3,$4 FROM users WHERE id=$2 ON CONFLICT(legacy_token_hash) DO NOTHING',[randomUUID(),payload.sub,new Date(legacyDeadline),fingerprint]);}
  }
  const condition=legacy?'a.legacy_token_hash=$1':'a.id=$1';
  const row=(await pool.query('SELECT a.*,u.tg_id FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE '+condition+' AND a.user_id=$2',[legacy?fingerprint:payload.jti,payload.sub])).rows[0];
  if(!active(row))unauthorized();
  const jwtDeadline=legacy?legacyDeadline:payload.exp*1000;
  if(+clock()>=jwtDeadline&&(!allowExpired||+new Date(row.expires_at)<=jwtDeadline))unauthorized();
  req.user={id:row.user_id,tgId:Number(row.tg_id)};req.authSession=row;return row;
 };
 const register=(route,app)=>{
  startRenewalCleanup(app,pool,config,clock);
  route('GET','/auth/access',async req=>{const session=await authenticate(req,true);const current=clock();return {expires_at:new Date(session.expires_at).toISOString(),server_time:current.toISOString(),access_token:await sign(session),token_type:'Bearer',renewal:session.renewal_token&&+current<+new Date(session.renewal_expires_at)?{expires_at:new Date(session.renewal_expires_at).toISOString()}:null};});
  route('POST','/auth/renew/request',async req=>{parse(z.object({}).strict(),req.body);return tx(async client=>{
   const session=(await client.query('SELECT * FROM auth_sessions WHERE id=$1 FOR UPDATE',[req.authSession.id])).rows[0];if(!active(session))unauthorized();const current=clock(),remaining=+new Date(session.expires_at)-+current;
   if(remaining>300000)throw new ApiError(409,'RENEWAL_NOT_AVAILABLE');
   if(session.renewal_token&&session.renewal_requested_at&&+current-+new Date(session.renewal_requested_at)<90000)return {status:'requested',expires_at:new Date(session.renewal_expires_at).toISOString(),retry_after_seconds:Math.ceil((90000-(+current-+new Date(session.renewal_requested_at)))/1000)};
   if(session.renewal_message_id){let edited;try{edited=await editor({chat_id:req.user.tgId,message_id:Number(session.renewal_message_id)});}catch{}if(!edited?.ok)throw new ApiError(503,'TELEGRAM_UNAVAILABLE');}
   const token=randomBytes(32).toString('base64url'),deadline=new Date(Math.min(+current+300000,+new Date(session.expires_at)));
   await client.query('UPDATE auth_sessions SET renewal_token=$2,renewal_expires_at=$3,renewal_requested_at=$4 WHERE id=$1',[session.id,token,deadline,current]);
   let delivered;try{delivered=await transport({chat_id:req.user.tgId,text:'Подтвердите продолжение сессии на сайте. Если не подтвердить, после её завершения потребуется снова войти по коду',reply_markup:{inline_keyboard:[[{text:'Подтвердить сессию на сайте',callback_data:'sr_'+token}]]}});}catch{}
   if(!delivered?.ok)throw new ApiError(503,'TELEGRAM_UNAVAILABLE');
   const messageId=Number.isSafeInteger(delivered.message_id)&&delivered.message_id>0?delivered.message_id:null;
   await client.query('UPDATE auth_sessions SET renewal_message_id=$3 WHERE id=$1 AND renewal_token=$2',[session.id,token,messageId]);
   return {status:'requested',expires_at:deadline.toISOString(),retry_after_seconds:90};
  });},req=>authenticate(req));
  route('POST','/bot/session/confirm',async req=>{
   const supplied=Buffer.from(req.headers['x-bot-secret']||''),expected=Buffer.from(config.botApiSecret);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new ApiError(401,'UNAUTHORIZED');
   const body=parse(z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),tg_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict(),req.body);
   return tx(async client=>{const session=(await client.query('SELECT a.*,u.tg_id FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE a.renewal_token=$1 FOR UPDATE OF a',[body.token])).rows[0];const current=clock();if(!active(session)||!session.renewal_expires_at||+current>=+new Date(session.renewal_expires_at))throw new ApiError(410,'RENEWAL_EXPIRED');if(Number(session.tg_id)!==body.tg_id)throw new ApiError(403,'FORBIDDEN');const deadline=new Date((Math.floor(+current/1000)+1800)*1000);await client.query('UPDATE auth_sessions SET expires_at=$2,renewal_token=NULL,renewal_expires_at=NULL WHERE id=$1',[session.id,deadline]);return {status:'confirmed',expires_at:deadline.toISOString()};});
  });
  route('POST','/auth/logout',async req=>{parse(z.object({}).strict(),req.body);return tx(async client=>{const session=(await client.query('SELECT * FROM auth_sessions WHERE id=$1 FOR UPDATE',[req.authSession.id])).rows[0];if(!active(session))unauthorized();await client.query('UPDATE auth_sessions SET revoked_at=$2,renewal_token=NULL,renewal_expires_at=NULL WHERE id=$1',[session.id,clock()]);return {status:'logged_out'};});},req=>authenticate(req));
 };
 return {authenticate,linkPending,sign,register};
}
