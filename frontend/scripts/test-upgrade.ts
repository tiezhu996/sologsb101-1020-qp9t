import 'fake-indexeddb/auto';
import Dexie from 'dexie';

// 1) 以 v2 结构建库并写入无版本字段的历史数据
const oldDb = new Dexie('gbrubbing');
oldDb.version(2).stores({
  steles: 'id, title, era, form, location, updatedAt',
  rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
  losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
  seals: 'id, rubbingId, sealType, position, updatedAt',
  compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
});
await oldDb.open();
await oldDb.table('steles').put({ id: 'st_old', title: '旧碑', era: '汉', location: '洛阳', form: 'stele', sizeCm: '', calligrapher: '', createdAt: 1, updatedAt: 2 });
await oldDb.table('compares').put({ id: 'cmp_old', steleId: 'st_old', rubbingIdA: 'r1', rubbingIdB: 'r2', diffCount: 5, conclusion: 'early', operator: '前人', date: '2025-01-01', createdAt: 1, updatedAt: 2 });
await oldDb.close();

// 2) 用当前 db.ts 重新打开，应触发 v2→v3 升级
const { db, initDatabase } = await import('../src/utils/db');
await initDatabase();
const stele = await db.steles.get('st_old');
const compare = await db.compares.get('cmp_old');
console.log('stele:', JSON.stringify({ v: stele?.version, b: stele?.baseVersion, title: stele?.title }));
console.log('compare:', JSON.stringify({ v: compare?.version, b: compare?.baseVersion, op: compare?.operator, dc: compare?.diffCount }));
if (stele?.version !== 1 || stele.baseVersion !== 1) throw new Error('stele 未补初始基准');
if (compare?.version !== 1 || compare.baseVersion !== 1) throw new Error('compare 未补初始基准');
if (compare.operator !== '前人' || compare.diffCount !== 5) throw new Error('已有比对记录内容受损');
if ((await db.tombstones.count()) !== 0 || (await db.conflicts.count()) !== 0) throw new Error('协作表应为空');
console.log('升级验证通过');
await db.close();
