import 'dotenv/config';
import {readFile} from 'node:fs/promises';
import {createPool,migrate} from '../server/db.mjs';
import {buildApp} from '../server/app.mjs';
import {loadConfig} from '../server/config.mjs';
import {SignJWT} from 'jose';
const pool=createPool(process.env.DATABASE_URL);
let app;
try{
 const config=loadConfig();await migrate(pool);
 const account=(await pool.query('SELECT id FROM users WHERE tg_id=ANY($1::bigint[]) LIMIT 1',[config.adminTgIds])).rows[0];
 if(!account)throw Error('Сначала зарегистрируйте администратора');
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(account.id).setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(config.jwtSecret));
 app=await buildApp({pool,config});
 const payload=JSON.parse(await readFile('.local/initial-users.json','utf8'));
 const response=await app.inject({method:'POST',url:'/api/v1/admin/initial-users/import',headers:{authorization:'Bearer '+token},payload});
 const result=response.json();
 if(response.statusCode!==200){console.error(JSON.stringify({status:response.statusCode,fields:result.error?.fields}));process.exitCode=1;}else console.log(JSON.stringify({imported:payload.rows.length,...result}));
}finally{await app?.close();await pool.end();}
