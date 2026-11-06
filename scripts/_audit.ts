import { pool } from '../src/db/client.js';
await pool.query(`
  create table if not exists _audit (id bigserial primary key, at timestamptz default now(),
    pid int default pg_backend_pid(), app text default current_setting('application_name'), what text)`);
await pool.query(`
  create or replace function _audit_row() returns trigger language plpgsql as $$
  begin insert into _audit(what) values ('row_delete:' || coalesce(old.key, '?')); return old; end $$`);
await pool.query(`
  create or replace function _audit_trunc() returns trigger language plpgsql as $$
  begin insert into _audit(what) values ('truncate'); return null; end $$`);
await pool.query(`drop trigger if exists _audit_del on app_settings`);
await pool.query(`create trigger _audit_del after delete on app_settings for each row execute function _audit_row()`);
await pool.query(`drop trigger if exists _audit_tr on app_settings`);
await pool.query(`create trigger _audit_tr before truncate on app_settings for each statement execute function _audit_trunc()`);
await pool.query(`insert into app_settings (key, value) values ('sentinel.x','1') on conflict (key) do nothing`);
await new Promise((r) => setTimeout(r, 6000));
const rows = await pool.query(`select at, pid, app, what from _audit order by id desc limit 15`);
console.log(rows.rows);
const alive = await pool.query(`select 1 from app_settings where key='sentinel.x'`);
console.log('sentinel alive?', alive.rowCount);
await pool.end();
