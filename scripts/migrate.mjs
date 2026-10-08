import 'dotenv/config';
import {createPool,migrate} from '../server/db.mjs';
const pool=createPool(process.env.DATABASE_URL);
try{await migrate(pool);console.log('Миграции применены.');}finally{await pool.end();}
