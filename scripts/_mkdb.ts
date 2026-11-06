import { Pool } from 'pg';
const admin = new Pool({ connectionString: 'postgres://postgres:flowers@localhost:54330/postgres' });
const exists = await admin.query(`select 1 from pg_database where datname = 'flowers_p212'`);
if (exists.rowCount === 0) await admin.query('create database flowers_p212');
console.log('db ready');
await admin.end();
