import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'application.spec.mjs',workers:1,timeout:60000,use:{locale:'en-US',timezoneId:'America/Los_Angeles',viewport:{width:1440,height:1000},trace:'retain-on-failure'},reporter:'list'});
