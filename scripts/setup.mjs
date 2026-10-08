import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
export function setupLocal(){
 if(existsSync('.env')) return;
 mkdirSync('.local',{recursive:true});
 const secret=()=>randomBytes(32).toString('hex');
 const password=secret();
 writeFileSync('.env',[
 'NODE_ENV=development','HOST=127.0.0.1','PORT=3000',
 'DATABASE_URL=postgresql://tournament:'+password+'@127.0.0.1:55432/tournament',
 'JWT_SECRET='+secret(),'BOT_API_SECRET='+secret(),'AUTH_JWT_TTL_SECONDS=1800',
 'BOT_USERNAME=LOCAL_DEMO_BOT','BOT_TOKEN=','ADMIN_TG_IDS=900001,900002',
 '# Date starts empty and is configured through the admin interface.',
 'PUBLIC_BASE_URL=http://127.0.0.1:3000',
 'BACKEND_URL=http://127.0.0.1:3000','LOCAL_DEMO=true',''
 ].join('\n'),{mode:0o600});
 console.log('Локальная конфигурация создана. Секреты сохранены в .env.');
}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/setup.mjs'))setupLocal();
