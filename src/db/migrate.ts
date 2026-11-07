import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';

/**
 * 迁移时把 PG 的 `RAISE NOTICE` 打到 stdout。
 *
 * 为什么需要这一行：P4-09 的平台词表迁移会**丢掉**认不出的键，而「丢了什么」只能
 * 由迁移自己知道（`RAISE NOTICE`）。node-postgres 默认把 notice 事件吞掉，
 * 于是那条提示会变成一句没人看见的日志——一次静默的数据损失。
 *
 * 挂在 `pool` 的 `connect` 上而不是某个 client 上：迁移用哪个连接由 drizzle 决定，
 * 每一个新建的连接都要挂一次。
 */
pool.on('connect', (client) => {
  client.on('notice', (notice) => {
    process.stdout.write(`NOTICE: ${notice.message ?? ''}\n`);
  });
});

await migrate(db, { migrationsFolder: './src/db/migrations' });
await pool.end();
