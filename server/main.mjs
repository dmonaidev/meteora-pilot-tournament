import 'dotenv/config';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import staticPlugin from '@fastify/static';
import {loadConfig} from './config.mjs';
import {createPool,migrate} from './db.mjs';
import {buildApp} from './app.mjs';
import {seedDemo,registerDemo} from '../scripts/demo.mjs';
import {registerNotifications} from '../bot/notifications.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=loadConfig();
const pool=createPool(config.databaseUrl);
await migrate(pool);
if(config.localDemo)await seedDemo(pool);
const app=buildApp({pool,config});
registerNotifications(app,pool,config);
await registerDemo(app,pool,config);
app.get('/health',async(_req,reply)=>{try{await pool.query('SELECT 1');return{status:'ok'};}catch{return reply.code(503).send({status:'unavailable'});}});
const dist=resolve(root,'dist');
if(existsSync(resolve(dist,'index.html'))){
 await app.register(staticPlugin,{root:dist});
 app.setNotFoundHandler((req,reply)=>{if(req.method==='GET'&&!req.url.startsWith('/api/')&&!req.url.startsWith('/health'))return reply.sendFile('index.html');return reply.code(404).send({error:{code:'NOT_FOUND',message:'Маршрут не найден',fields:[]}});});
}
await app.listen({host:config.host,port:config.port});
console.log('Meteora $MET Tournament: http://'+config.host+':'+config.port+(config.localDemo?' — локальная версия':''));
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;await app.close();await pool.end();process.exit(0);}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
