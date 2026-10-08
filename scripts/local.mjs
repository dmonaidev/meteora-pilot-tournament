import {setupLocal} from './setup.mjs';
import {config as dotenv} from 'dotenv';
import {spawn} from 'node:child_process';
setupLocal();dotenv();
const {startLocalPostgres}=await import('./postgres.mjs');
const handle=await startLocalPostgres();
function run(command,args){return spawn(command,args,{stdio:'inherit',windowsHide:true,shell:false,env:process.env});}
const build=run(process.execPath,['node_modules/vite/bin/vite.js','build','--config','web/vite.config.mjs']);
await new Promise((resolve,reject)=>{build.on('error',reject);build.on('exit',code=>code===0?resolve():reject(Error('Frontend build failed')));});
const app=run(process.execPath,['server/main.mjs']);
let bot=null;
if(process.env.BOT_TOKEN)bot=run(process.execPath,['bot/main.mjs']);
else console.log('Telegram token не задан. В браузере доступен отдельный локальный демо-вход.');
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;app.kill();bot?.kill();if(handle.owned)await handle.database.stop();process.exit(0);}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
app.once('exit',code=>{if(!stopping){console.error('Приложение остановилось, код',code);shutdown();}});
