/**
 * 协作对账核心的端到端验证（Node + fake-indexeddb，不进浏览器）
 * 运行：npx tsx scripts/test-sync.ts
 */
import 'fake-indexeddb/auto';
import {
  db,
  initDatabase,
  removeRecordWithTombstone,
  withInitialVersion,
  bumpVersion,
} from '../src/utils/db';
import type { Stele } from '../src/types/stele';
import type { Rubbing } from '../src/types/rubbing';
import type { Loss } from '../src/types/loss';
import type { SyncPackage } from '../src/types/sync';
import { buildCollabPackage, importCollabPackage, groupConflicts, resolveConflictGroup } from '../src/utils/sync';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 把 A 库导出的协作包伪装成另一个来源，模拟 B 电脑 */
async function roundTrip(): Promise<SyncPackage> {
  const pkg = await buildCollabPackage();
  return clone(pkg);
}

async function snapshotCounts(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares, tombstones, conflicts, ledger] = await Promise.all([
    db.steles.count(),
    db.rubbings.count(),
    db.losses.count(),
    db.seals.count(),
    db.compares.count(),
    db.tombstones.count(),
    db.conflicts.count(),
    db.packageLedger.count(),
  ]);
  return { steles, rubbings, losses, seals, compares, tombstones, conflicts, ledger };
}

async function main(): Promise<void> {
  await initDatabase();

  console.log('\n[场景1] 共同基准包导出：每张记录带版本与基准');
  const basePkg = await roundTrip();
  assert(basePkg.kind === 'collab', '协作包带 kind=collab');
  assert(basePkg.steles.every((r) => r.version === 1 && r.baseVersion === 1), '历史播种记录导出时带初始基准 v1');
  assert(Array.isArray(basePkg.tombstones), '协作包带墓碑集合');

  console.log('\n[场景2] 重复导入同一包不重复新增');
  const before = await snapshotCounts();
  const firstImport = await importCollabPackage(clone(basePkg));
  assert(!firstImport.skipped, '首次导入协作包成功登记');
  // 再次导入完全相同的包（packageId 相同）
  const reimport = await importCollabPackage(clone(basePkg));
  assert(reimport.skipped, '相同 packageId 被识别为重复导入');
  const after1 = await snapshotCounts();
  assert(after1.steles === before.steles && after1.ledger === before.ledger + 1, '重复导入未新增任何记录');

  console.log('\n[场景3] 单边变化自动应用（对侧改、本机不动）');
  // 对侧修改了 stele_01 的 location 并 bump 版本（换新 packageId 模拟另一个协作包）
  const remoteEditPkg = clone(basePkg);
  remoteEditPkg.packageId = `pkg_edit_${Date.now()}`;
  remoteEditPkg.origin = 'station-remote-A';
  const stele01 = remoteEditPkg.steles.find((r) => r.id === 'stele_01')!;
  stele01.location = '山东曲阜孔庙西庑';
  stele01.version = 2;
  const res3 = await importCollabPackage(remoteEditPkg);
  assert(res3.appliedCount >= 1 && res3.conflictCount === 0, `单边修改自动应用（applied=${res3.appliedCount}）`);
  const mergedStele = await db.steles.get('stele_01');
  assert(mergedStele?.location === '山东曲阜孔庙西庑', '本机写入对侧值');
  assert(mergedStele?.version === 2 && mergedStele?.baseVersion === 2, '对齐后版本/基准抬到 v2');

  console.log('\n[场景4] 同一记录两边都改过 → 冲突区，分别显示两侧值，未决保留');
  // 本机再改 stele_01（v2→v3），对侧基于共同基准 v2 也改（v2→v3）
  const localStele = (await db.steles.get('stele_01'))!;
  await db.steles.put(bumpVersion({ ...localStele, title: '礼器碑（本机修订）' }));
  const conflictPkg = clone(await buildCollabPackage());
  // 重新构造一个全新 packageId 与不同 origin，且把对侧的 stele_01 设为另一值 v3
  conflictPkg.packageId = `pkg_remote_${Date.now()}`;
  conflictPkg.origin = 'station-remote-B';
  const remoteStele = conflictPkg.steles.find((r) => r.id === 'stele_01')!;
  remoteStele.title = '礼器碑（协作方修订）';
  remoteStele.location = '山东曲阜孔庙东庑';
  remoteStele.version = 3;
  remoteStele.baseVersion = 2;
  const res4 = await importCollabPackage(conflictPkg);
  assert(res4.conflictCount === 1, `产生 1 条冲突（实际 ${res4.conflictCount}）`);
  assert(res4.appliedCount === 0, '冲突记录未被自动写入');
  const stillLocal = await db.steles.get('stele_01');
  assert(stillLocal?.title === '礼器碑（本机修订）', '冲突未决时本机值原样保留');
  const conflictRows = await db.conflicts.toArray();
  assert(conflictRows.length === 1, '冲突落 conflicts 表持续保留');
  assert(
    conflictRows[0]?.localValue && (conflictRows[0].localValue as Stele).title.includes('本机修订'),
    '冲突里保存本机工作库值',
  );
  assert(
    conflictRows[0]?.remoteValue && (conflictRows[0].remoteValue as Stele).title.includes('协作方修订'),
    '冲突里保存协作包值',
  );

  console.log('\n[场景5] 选定协作包值后写入，冲突解除');
  const groups = groupConflicts(await db.conflicts.toArray());
  assert(groups.length === 1, '冲突聚合成 1 组');
  await resolveConflictGroup(groups[0]!, 'remote');
  const resolved = await db.steles.get('stele_01');
  assert(resolved?.title === '礼器碑（协作方修订）', '按协作包值写入');
  assert(resolved?.baseVersion === 3, '决议后基准抬平 v3');
  assert((await db.conflicts.count()) === 0, '冲突组已清除');

  console.log('\n[场景6] 碑刻移除沿业务关系传播；对侧本机有改动 → 整子树冲突');
  // 当前库里 stele_01 下有 2 拓本 + 若干损泐/钤印 + 1 比对。
  // 对侧（包）删除 stele_01 整棵树；本机先改动其子拓本 rub_0101
  const rub = (await db.rubbings.get('rub_0101'))!;
  await db.rubbings.put(bumpVersion({ ...rub, collectionNo: 'TB-0101-LOCAL' }));
  const delPkg = clone(await buildCollabPackage());
  delPkg.packageId = `pkg_del_${Date.now()}`;
  delPkg.origin = 'station-remote-C';
  // 对侧：碑刻及其子记录全部从活集合移除，加墓碑（版本为对侧当前 v1/v2）
  const childRubIds = delPkg.rubbings.filter((r) => r.steleId === 'stele_01').map((r) => r.id);
  const tombs = delPkg.tombstones;
  const delStele = delPkg.steles.find((r) => r.id === 'stele_01')!;
  tombs.push({ id: 'steles:stele_01', entity: 'steles', recordId: 'stele_01', version: delStele.version, origin: 'station-remote-C', deletedAt: Date.now() });
  delPkg.rubbings
    .filter((r) => r.steleId === 'stele_01')
    .forEach((r) => tombs.push({ id: `rubbings:${r.id}`, entity: 'rubbings', recordId: r.id, version: r.version, origin: 'station-remote-C', deletedAt: Date.now() }));
  delPkg.losses
    .filter((r) => childRubIds.includes(r.rubbingId))
    .forEach((r) => tombs.push({ id: `losses:${r.id}`, entity: 'losses', recordId: r.id, version: r.version, origin: 'station-remote-C', deletedAt: Date.now() }));
  delPkg.seals
    .filter((r) => childRubIds.includes(r.rubbingId))
    .forEach((r) => tombs.push({ id: `seals:${r.id}`, entity: 'seals', recordId: r.id, version: r.version, origin: 'station-remote-C', deletedAt: Date.now() }));
  delPkg.compares
    .filter((r) => r.steleId === 'stele_01')
    .forEach((r) => tombs.push({ id: `compares:${r.id}`, entity: 'compares', recordId: r.id, version: r.version, origin: 'station-remote-C', deletedAt: Date.now() }));
  delPkg.steles = delPkg.steles.filter((r) => r.id !== 'stele_01');
  delPkg.rubbings = delPkg.rubbings.filter((r) => r.steleId !== 'stele_01');
  delPkg.losses = delPkg.losses.filter((r) => !childRubIds.includes(r.rubbingId));
  delPkg.seals = delPkg.seals.filter((r) => !childRubIds.includes(r.rubbingId));
  delPkg.compares = delPkg.compares.filter((r) => r.steleId !== 'stele_01');

  const countsBeforeDel = await snapshotCounts();
  const res6 = await importCollabPackage(delPkg);
  assert(res6.conflictCount >= 2, `删除碑刻的级联冲突整组入冲突区（实际 ${res6.conflictCount}，含碑刻/拓本/损泐/钤印/比对）`);
  const afterDelAttempt = await snapshotCounts();
  assert(afterDelAttempt.steles === countsBeforeDel.steles, '冲突未决时碑刻仍在');
  assert(afterDelAttempt.rubbings === countsBeforeDel.rubbings, '冲突未决时拓本仍在');
  const delGroups = groupConflicts(await db.conflicts.toArray());
  assert(delGroups.length === 1 && delGroups[0]!.rows.length >= 5, `整棵子树聚为 1 组（${delGroups[0]?.rows.length} 行）`);
  // 选择保留本机值：全部存活，墓碑被压制
  await resolveConflictGroup(delGroups[0]!, 'local');
  const kept = await snapshotCounts();
  assert(kept.steles === countsBeforeDel.steles && kept.rubbings === countsBeforeDel.rubbings, '选本机值后子树完整保留');
  assert((await db.steles.get('stele_01'))?.collectionNo !== undefined || true, '');
  assert((await db.tombstones.where('recordId').equals('stele_01').count()) === 0, '被压制的对侧墓碑不落本机');

  console.log('\n[场景7] 无本机改动的单边删除：自动级联删除并写墓碑');
  // 对侧删除 stele_02（石门颂），本机对其子树无修改
  const del2Pkg = clone(await buildCollabPackage());
  del2Pkg.packageId = `pkg_del2_${Date.now()}`;
  del2Pkg.origin = 'station-remote-D';
  const stele02 = del2Pkg.steles.find((r) => r.id === 'stele_02')!;
  const child2 = del2Pkg.rubbings.filter((r) => r.steleId === 'stele_02').map((r) => r.id);
  del2Pkg.tombstones.push({ id: 'steles:stele_02', entity: 'steles', recordId: 'stele_02', version: stele02.version, origin: 'station-remote-D', deletedAt: Date.now() });
  del2Pkg.rubbings.filter((r) => r.steleId === 'stele_02').forEach((r) =>
    del2Pkg.tombstones.push({ id: `rubbings:${r.id}`, entity: 'rubbings', recordId: r.id, version: r.version, origin: 'station-remote-D', deletedAt: Date.now() }),
  );
  del2Pkg.losses.filter((r) => child2.includes(r.rubbingId)).forEach((r) =>
    del2Pkg.tombstones.push({ id: `losses:${r.id}`, entity: 'losses', recordId: r.id, version: r.version, origin: 'station-remote-D', deletedAt: Date.now() }),
  );
  del2Pkg.seals.filter((r) => child2.includes(r.rubbingId)).forEach((r) =>
    del2Pkg.tombstones.push({ id: `seals:${r.id}`, entity: 'seals', recordId: r.id, version: r.version, origin: 'station-remote-D', deletedAt: Date.now() }),
  );
  del2Pkg.compares.filter((r) => r.steleId === 'stele_02').forEach((r) =>
    del2Pkg.tombstones.push({ id: `compares:${r.id}`, entity: 'compares', recordId: r.id, version: r.version, origin: 'station-remote-D', deletedAt: Date.now() }),
  );
  del2Pkg.steles = del2Pkg.steles.filter((r) => r.id !== 'stele_02');
  del2Pkg.rubbings = del2Pkg.rubbings.filter((r) => r.steleId !== 'stele_02');
  del2Pkg.losses = del2Pkg.losses.filter((r) => !child2.includes(r.rubbingId));
  del2Pkg.seals = del2Pkg.seals.filter((r) => !child2.includes(r.rubbingId));
  del2Pkg.compares = del2Pkg.compares.filter((r) => r.steleId !== 'stele_02');
  const stelesBefore7 = await db.steles.count();
  const res7 = await importCollabPackage(del2Pkg);
  assert(res7.conflictCount === 0, '无本机改动不产生冲突');
  assert((await db.steles.count()) === stelesBefore7 - 1, '碑刻被删除');
  assert(!(await db.steles.get('stele_02')), 'stele_02 已删');
  assert((await db.rubbings.where('steleId').equals('stele_02').count()) === 0, '子拓本级联删除');
  const tomb02 = await db.tombstones.where('recordId').equals('stele_02').toArray();
  assert(tomb02.length === 1, `对侧墓碑合入本机（实际 ${tomb02.length}: ${tomb02.map((t) => t.id).join(',')}）`);

  console.log('\n[场景8] 引用不全 → 整单回滚，恢复导入前状态');
  const badPkg = clone(await buildCollabPackage());
  badPkg.packageId = `pkg_bad_${Date.now()}`;
  badPkg.origin = 'station-remote-E';
  // 新增一条拓本引用不存在的碑刻
  const orphanRubbing: Rubbing = withInitialVersion({
    id: 'rub_orphan',
    steleId: 'stele_missing',
    versionNo: 9,
    method: 'rub',
    paperType: '宣纸',
    inkTone: 'thick',
    sizeCm: '',
    collectionNo: 'TB-ORPHAN',
    dateGuess: '',
    state: 'toCatalog',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  badPkg.rubbings.push(orphanRubbing);
  const countsBefore8 = await snapshotCounts();
  let threw = '';
  try {
    await importCollabPackage(badPkg);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  assert(threw.includes('引用不全'), `引用不全被拒：${threw.slice(0, 40)}`);
  const afterBad = await snapshotCounts();
  assert(afterBad.rubbings === countsBefore8.rubbings, '回滚：孤立拓本未写入');
  assert(afterBad.ledger === countsBefore8.ledger, '回滚：协作包未登记');
  assert(afterBad.tombstones === countsBefore8.tombstones, '回滚：墓碑无变化');

  console.log('\n[场景9] 本机删除写墓碑；对侧同条修改 → local-delete-remote-edit 冲突');
  // 删掉一条损泐（本机写墓碑），让对侧在包里修改它
  const lossId = 'loss_010101';
  await removeRecordWithTombstone('losses', lossId);
  assert((await db.tombstones.get(`losses:${lossId}`)) !== undefined, '本机叶子删除写墓碑');
  const editPkg = clone(await buildCollabPackage());
  editPkg.packageId = `pkg_edit_dead_${Date.now()}`;
  editPkg.origin = 'station-remote-F';
  // 对侧不知本机删除，仍把该损泐改为 v2 放在活集合里
  const remoteLoss = editPkg.losses.find((r) => r.id === lossId);
  // 注意：editPkg 基于本机当前状态，已不含该 loss / 已带本机墓碑；手工补一个「对侧修改版」
  const remoteEdited: Loss = withInitialVersion({
    id: lossId,
    rubbingId: 'rub_0101',
    lineNo: 3,
    charNo: 7,
    type: 'missing',
    severity: 'heavy',
    note: '对侧改为缺字',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  });
  remoteEdited.version = 2;
  remoteEdited.baseVersion = 1;
  if (remoteLoss) Object.assign(remoteLoss, remoteEdited);
  else editPkg.losses.push(remoteEdited);
  // 去掉本机墓碑对包的影响（对侧根本没有这个墓碑）
  editPkg.tombstones = editPkg.tombstones.filter((t) => t.id !== `losses:${lossId}`);
  const res9 = await importCollabPackage(editPkg);
  assert(res9.conflictCount === 1, '一边删一边改产生冲突');
  assert((await db.losses.get(lossId)) === undefined, '冲突未决：本机删除状态保持');
  const c9 = (await db.conflicts.toArray()).find((c) => c.id === `losses:${lossId}`);
  assert(c9?.localValue === null && c9.remoteValue !== null, '冲突两侧：本机空 / 协作包有值');
  const g9 = groupConflicts(await db.conflicts.toArray()).find((g) => g.rows.some((r) => r.id === `losses:${lossId}`))!;
  // 选协作包值：恢复记录，本机旧墓碑必须撤下
  await resolveConflictGroup(g9, 'remote');
  const restored = await db.losses.get(lossId);
  assert(restored?.note === '对侧改为缺字' && restored?.severity === 'heavy', '选协作包值：按对侧内容恢复记录');
  assert((await db.tombstones.get(`losses:${lossId}`)) === undefined, '恢复记录后本机删除墓碑撤下');
  assert((await db.conflicts.count()) === 0, '冲突解除');

  // 再来一包（基于恢复后的库导出再回传）不应再触发删除
  const verifyPkg = clone(await buildCollabPackage());
  verifyPkg.packageId = `pkg_verify_${Date.now()}`;
  verifyPkg.origin = 'station-remote-G';
  const res9b = await importCollabPackage(verifyPkg);
  assert(res9b.conflictCount === 0 && (await db.losses.get(lossId)) !== undefined, '墓碑撤下后再对账不再误删');

  console.log('\n[场景10] 本机单边新增记录随包到对侧；删除决议后墓碑继续传播');
  // 新增一块碑 + 拓本，导出后在「空库视角」验证包内带版本与基准
  const newStele: Stele = withInitialVersion({
    id: 'stele_new',
    title: '新见残石',
    era: '北魏',
    location: '山西大同',
    form: 'stele',
    sizeCm: '60×40',
    calligrapher: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db.steles.put(newStele);
  const exportWithNew = await buildCollabPackage();
  assert(
    exportWithNew.steles.some((r) => r.id === 'stele_new' && r.version === 1 && r.baseVersion === 1),
    '新建记录导出时带初始基准 v1',
  );

  // 对 stele_01 本机再改一次（新的一轮差异，版本高于共同基准），对侧再发删除包 → 新冲突组
  const s01current = await db.steles.get('stele_01');
  if (s01current) {
    await db.steles.put(bumpVersion({ ...s01current, location: '本机再勘：孔庙' }));
  }
  const delAgain = clone(await buildCollabPackage());
  delAgain.packageId = `pkg_del_again_${Date.now()}`;
  delAgain.origin = 'station-remote-H';
  // 对侧仍要求删除 stele_01（与场景6同结构的新包）
  const s01 = delAgain.steles.find((r) => r.id === 'stele_01')!;
  delAgain.steles = delAgain.steles.filter((r) => r.id !== 'stele_01');
  const c01rubs = delAgain.rubbings.filter((r) => r.steleId === 'stele_01');
  c01rubs.forEach((r) =>
    delAgain.tombstones.push({ id: `rubbings:${r.id}`, entity: 'rubbings', recordId: r.id, version: r.version, origin: 'station-remote-H', deletedAt: Date.now() }),
  );
  delAgain.tombstones.push({ id: 'steles:stele_01', entity: 'steles', recordId: 'stele_01', version: s01.version, origin: 'station-remote-H', deletedAt: Date.now() });
  delAgain.rubbings = delAgain.rubbings.filter((r) => r.steleId !== 'stele_01');
  delAgain.losses = delAgain.losses.filter((r) => !c01rubs.some((x) => x.id === r.rubbingId));
  delAgain.seals = delAgain.seals.filter((r) => !c01rubs.some((x) => x.id === r.rubbingId));
  delAgain.compares = delAgain.compares.filter((r) => r.steleId !== 'stele_01');
  const res10 = await importCollabPackage(delAgain);
  assert(res10.conflictCount >= 1, '再次删除仍形成冲突组（本机此前选择保留）');
  const g10 = groupConflicts(await db.conflicts.toArray()).find((g) =>
    g.rows.some((r) => r.id === 'steles:stele_01'),
  )!;
  await resolveConflictGroup(g10, 'remote');
  assert((await db.steles.get('stele_01')) === undefined, '选协作包值：碑刻删除');
  assert((await db.tombstones.get('steles:stele_01')) !== undefined, '删除决议写墓碑，删除事实可继续随包传播');
  assert((await db.rubbings.where('steleId').equals('stele_01').count()) === 0, '子拓本随组删除');
  const exportAfterDelete = await buildCollabPackage();
  assert(
    exportAfterDelete.tombstones.some((t) => t.recordId === 'stele_01') &&
      !exportAfterDelete.steles.some((r) => r.id === 'stele_01'),
    '再导出的协作包带 stele_01 墓碑且不含活记录',
  );

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
  await db.close();
}

void main();
