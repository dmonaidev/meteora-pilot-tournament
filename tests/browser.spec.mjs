import 'dotenv/config';
import {test,expect} from '@playwright/test';
import pg from 'pg';

test('desktop: participant submission → admin approval → PNL import → leaderboard',async({page})=>{
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const user=(await pool.query('SELECT * FROM users WHERE tg_id=100002')).rows[0];
 if(!user)throw Error('Start local demo first');
 const original={};
 for(const table of ['wallets','partner_rewards','tournament_scoring'])original[table]=(await pool.query('SELECT * FROM '+table+' WHERE user_id=$1',[user.id])).rows[0];
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'С возвращением'})).toBeVisible();
 await page.getByRole('button',{name:'Открыть публичный лидерборд'}).click();
 await expect(page.locator('tbody tr').filter({hasText:'NOVA'})).toHaveCount(1);
 await page.screenshot({path:'test-results/home-desktop.png',fullPage:true});
 await page.getByLabel('Демонстрационный аккаунт').selectOption('100002');
 await expect(page.getByRole('heading',{name:'Привет, Ваш участник'})).toBeVisible();
 await page.getByLabel('Адрес кошелька Solana',{exact:true}).fill('11111111111111111111111111111111');
 await expect(page.getByLabel('Хэш вывода с биржи',{exact:true})).toHaveCount(0);
 await page.getByLabel('Указать UID аккаунта на бирже').check();
 await page.getByLabel('UID аккаунта на бирже',{exact:true}).fill('001234');
 await page.getByLabel('Хэш вывода с биржи',{exact:true}).fill('browser-test-withdrawal');
 await page.getByRole('button',{name:'Сохранить профиль'}).click();
 await expect(page.getByRole('status')).toHaveText('Профиль сохранён');
 await expect(page.getByText('На проверке',{exact:true})).toHaveCount(2);
 await page.getByLabel('Демонстрационный аккаунт').selectOption('900001');
 await page.getByRole('button',{name:'Управление',exact:true}).click();
 const item=page.locator('.admin-user').filter({hasText:'Ваш участник'});
 await item.locator('summary').click();
 await item.getByLabel('Комментарий администратора (обязательный)').fill('Browser acceptance');
 await item.getByRole('button',{name:'Одобрить',exact:true}).click();
 await expect(item.getByText('Допуск подтверждён',{exact:true})).toBeVisible();
 await item.getByRole('button',{name:'Подтвердить',exact:true}).first().click();
 await expect(item.getByText('Подтверждено',{exact:true})).toHaveCount(1);
 await item.getByRole('button',{name:'Подтвердить',exact:true}).last().click();
 await expect(item.getByText('Подтверждено',{exact:true})).toHaveCount(2);
 await page.getByLabel('Файл результатов').setInputFiles({name:'scores.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({rows:[{tg_id:100002,pnl:'2000.000000'}]}))});
 await page.getByRole('button',{name:'Загрузить данные',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Импорт завершён');
 await page.screenshot({path:'test-results/admin-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Лидерборд',exact:true}).first().click();
 await expect(page.locator('tbody tr').first()).toContainText('Ваш участник');
 await expect(page.locator('tbody tr').first()).toContainText('2\u202f000,000000');
 await expect(page.locator('tbody tr').first()).toContainText('111…11111 | SpecialPartnerGift');
 await page.getByLabel('Демонстрационный аккаунт').selectOption('100002');
 await expect(page.getByRole('heading',{name:'Привет, Ваш участник',exact:true})).toBeVisible();
 await expect(page.locator('.score-main')).toContainText('2\u202f000,000000');
 await page.screenshot({path:'test-results/profile-desktop.png',fullPage:true});
 expect(errors).toEqual([]);
 }finally{
  const c=await pool.connect();
  try{await c.query('BEGIN');await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
   await c.query('UPDATE users SET registration_status=$2,admin_notes=$3 WHERE id=$1',[user.id,user.registration_status,user.admin_notes]);
   for(const table of ['wallets','partner_rewards','tournament_scoring']){
    await c.query('DELETE FROM '+table+' WHERE user_id=$1',[user.id]);
    const row=original[table];if(row){const columns=Object.keys(row);await c.query('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map((_,i)=>'$'+(i+1)).join(',')+')',columns.map(k=>row[k]));}
   }await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
 }
});

test('mobile: responsive layout, registration modal and demo profile',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await expect(page.getByLabel('Демонстрационный аккаунт')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/home-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Новый участник? Регистрация',exact:true}).click();
 const modal=page.getByRole('dialog');
 await modal.getByLabel('Имя в турнире').fill('MobileTrader');
 await modal.getByRole('button',{name:'Продолжить через Telegram'}).click();
 await expect(page.getByRole('link',{name:'Открыть бота в Telegram'})).toBeVisible();
 await expect(page.getByText(/Ожидаем подтверждение/)).toBeVisible();
 await page.getByRole('button',{name:'Закрыть',exact:true}).click();
 await page.getByLabel('Демонстрационный аккаунт').selectOption('100001');
 await expect(page.getByRole('heading',{name:'Привет, NOVA'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/profile-mobile.png',fullPage:true});
 expect(errors).toEqual([]);
});
