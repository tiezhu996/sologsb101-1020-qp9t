import 'fake-indexeddb/auto';
import Dexie from 'dexie';

const oldDb = new Dexie('gbrubbing');
oldDb.version(1).stores({
  steles: 'id, title, era, form, updatedAt',
  rubbings: 'id, steleId, versionNo, method, state, updatedAt',
  losses: 'id, rubbingId, lineNo, type, severity, updatedAt',
  seals: 'id, rubbingId, sealType, updatedAt',
  compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, updatedAt',
});
await oldDb.open();
await oldDb.table('losses').bulkPut([
  { id: 'l1', rubbingId: 'r1', lineNo: 1, type: 'blur', severity: 'light', note: 'a', createdAt: 1, updatedAt: 1 },
  { id: 'l2', rubbingId: 'r1', lineNo: 1, type: 'crack', severity: 'medium', note: 'b', createdAt: 1, updatedAt: 1 },
  { id: 'l3', rubbingId: 'r1', lineNo: 2, type: 'missing', severity: 'heavy', note: 'c', createdAt: 1, updatedAt: 1 },
]);
await oldDb.close();

const { db, initDatabase } = await import('../src/utils/db');
await initDatabase();
const losses = await db.losses.toArray();
console.log(losses.filter((l) => l.id.startsWith('l')).map((l) => `${l.id}: L${l.lineNo}C${l.charNo} v${l.version}/b${l.baseVersion}`).join(' '));
await db.close();
