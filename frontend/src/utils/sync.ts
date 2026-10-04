/**
 * 协作包（离线对账）核心
 *
 * 两台电脑（馆员离线补录）各自修改同一碑的拓本 / 损泐 / 钤印 / 比对记录后，
 * 通过协作包交换：
 *  - 导出时给每张业务记录带上「共同基准版本」baseVersion 与所锚定碑刻 steleId，
 *    并整体附上导出方最近一次共同基准快照；
 *  - 导入按 base / local（本机工作库）/ incoming（协作包）三方对账：
 *    只应用单边变化；同一记录两边都改过进入冲突区，分别保留两侧取值待人工选定。
 *  - 重复导入同一个包不重复新增（appliedPackages 登记 packageId）；
 *  - 引用不全（子记录找不到父记录）直接拒绝、不写入；
 *  - 应用全程在单个 IndexedDB 事务内完成，任何写入失败自动恢复导入前状态；
 *  - 未决冲突不写业务表、跨次导入继续保留。
 */
import {
  BASELINE_DOC_ID,
  db,
  ensureBaseline,
  readBusinessCollections,
  type BaselineDoc,
} from './db';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import {
  SYNC_TABLES,
  type AppliedPackage,
  type MergePlan,
  type SyncChange,
  type SyncCollections,
  type SyncConflict,
  type SyncConflictKind,
  type SyncRecord,
  type SyncTable,
} from '@/types/sync';
import { recordLabel, resolveSteleId } from './syncFields';

export type { MergePlan, SyncChange };

/** 协作包文件标识 */
export const SYNC_PACKAGE_APP = 'gbrubbing-sync-package';

export interface SyncPackage {
  app: typeof SYNC_PACKAGE_APP;
  /** 包唯一 id：同一包重复导入据此幂等去重 */
  packageId: string;
  producer: string;
  exportedAt: string;
  schemaVersion: number;
  /** 包内各表当前记录（非 steles 表会冗余 steleId 锚点） */
  collections: SyncCollections;
  /** 导出方最近一次共同基准快照（含 tombstone 效果：基准有、当前无 = 已删除） */
  baseline: SyncCollections;
  baselineAt: string;
}

/* ------------------------------ 记录等价 ------------------------------ */

/** 对账时忽略的元数据字段：时间戳每次写入都变，不能作为业务差异依据 */
const IGNORE_KEYS = new Set(['id', 'createdAt', 'updatedAt']);
/** 判断「业务内容是否收敛」时，基准版本号本身也不参与（两边版本号可能不同但内容一致） */
const CONTENT_IGNORE_KEYS = new Set([...IGNORE_KEYS, 'baseVersion']);
/** 子表冗余锚点，仅用于导出传递，不参与业务等价 */
const ANCHOR_KEY = 'steleId';

function signatureOf(record: SyncRecord | null | undefined, table: SyncTable, ignore: Set<string>): string {
  if (!record) return '';
  const source = record as unknown as Record<string, unknown>;
  const keys = Object.keys(source)
    .filter((key) => !ignore.has(key) && !(table !== 'steles' && table !== 'rubbings' && key === ANCHOR_KEY))
    .sort();
  return JSON.stringify(keys.map((key) => [key, source[key]]));
}

/** 变化检测签名：相对共同基准是否改过（基准版本号变化也算改动） */
function signature(record: SyncRecord | null | undefined, table: SyncTable): string {
  return signatureOf(record, table, IGNORE_KEYS);
}

/** 业务内容签名：仅比较实际业务字段，用于判断两边是否已收敛为同一结果 */
function contentSignature(record: SyncRecord | null | undefined, table: SyncTable): string {
  return signatureOf(record, table, CONTENT_IGNORE_KEYS);
}

/** 剥掉子表冗余的 steleId 锚点，写回时只保留各表自身字段 */
function stripAnchor(table: SyncTable, record: SyncRecord): SyncRecord {
  if (table === 'steles' || table === 'rubbings') return record;
  const { steleId: _omit, ...rest } = record as unknown as Record<string, unknown>;
  return rest as unknown as SyncRecord;
}

/* ------------------------------ 锚点解析 ------------------------------ */

type RelationContext = { steles: Stele[]; rubbings: Rubbing[] };

/** 给非 steles / rubbings 记录补冗余碑刻锚点（导出用） */
function withAnchor(table: SyncTable, record: SyncRecord, ctx: RelationContext): SyncRecord {
  if (table === 'steles' || table === 'rubbings') return record;
  const steleId = resolveSteleId(table, record, ctx);
  return { ...(record as object), steleId } as SyncRecord;
}

function anchorOf(
  table: SyncTable,
  record: SyncRecord | null,
  ctx: RelationContext,
  fallback?: { base?: SyncRecord | null; local?: SyncRecord | null; incoming?: SyncRecord | null },
): string | null {
  if (!record) return null;
  // 子表优先使用包内冗余的碑刻锚点：父拓本可能已在本机删除，不能靠当前关系反查
  if (table !== 'steles') {
    const explicit = (record as unknown as Record<string, unknown>).steleId;
    if (typeof explicit === 'string') return explicit;
  }
  const direct = resolveSteleId(table, record, ctx);
  if (direct) return direct;
  // 删除场景下当前记录可能缺父级：从三方中的另一侧补锚点
  for (const candidate of [fallback?.incoming, fallback?.local, fallback?.base]) {
    if (!candidate || candidate === record) continue;
    const explicit = (candidate as unknown as Record<string, unknown>).steleId;
    if (typeof explicit === 'string') return explicit;
  }
  if (table === 'compares' && record) return (record as Compare).steleId;
  return null;
}

/* ------------------------------ 导出协作包 ------------------------------ */

export async function exportSyncPackage(producer: string): Promise<SyncPackage> {
  const baselineDoc = await ensureBaseline();
  const collections = await readBusinessCollections();
  const ctx: RelationContext = { steles: collections.steles as Stele[], rubbings: collections.rubbings as Rubbing[] };
  const anchored: SyncCollections = {
    steles: collections.steles,
    rubbings: collections.rubbings,
    losses: collections.losses.map((row) => withAnchor('losses', row, ctx)),
    seals: collections.seals.map((row) => withAnchor('seals', row, ctx)),
    compares: collections.compares.map((row) => withAnchor('compares', row, ctx)),
  };
  return {
    app: SYNC_PACKAGE_APP,
    packageId: `pkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    producer: producer.trim() || '本机工作库',
    exportedAt: new Date().toISOString(),
    schemaVersion: 3,
    collections: anchored,
    baseline: baselineDoc.collections,
    baselineAt: new Date(baselineDoc.updatedAt).toISOString(),
  };
}

/* ------------------------------ 校验 ------------------------------ */

/** 校验协作包结构，返回错误文案（空串表示通过） */
export function validateSyncPackage(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const pkg = input as Partial<SyncPackage>;
  if (pkg.app !== SYNC_PACKAGE_APP) return '该文件不是协作包（app 标识不符）';
  if (typeof pkg.packageId !== 'string' || pkg.packageId.length === 0) return '协作包缺少 packageId';
  if (!pkg.collections || typeof pkg.collections !== 'object') return '协作包缺少当前记录集合 collections';
  if (!pkg.baseline || typeof pkg.baseline !== 'object') return '协作包缺少共同基准快照 baseline';
  for (const table of SYNC_TABLES) {
    if (!Array.isArray(pkg.collections[table])) return `协作包的当前记录缺少 ${table} 集合`;
    if (!Array.isArray(pkg.baseline[table])) return `协作包的共同基准缺少 ${table} 集合`;
  }
  return '';
}

/** 包内引用完整性：每条子记录的父记录必须都在包内（引用不全则整包拒绝，绝不写入） */
export function findReferenceGaps(pkg: SyncPackage): string[] {
  const gaps: string[] = [];
  const steleIds = new Set(pkg.collections.steles.map((row) => row.id));
  const rubbingIds = new Set(pkg.collections.rubbings.map((row) => row.id));
  pkg.collections.rubbings.forEach((row) => {
    if (!steleIds.has((row as Rubbing).steleId)) gaps.push(`拓本 ${row.id} 引用的碑刻 ${(row as Rubbing).steleId} 不在包内`);
  });
  pkg.collections.losses.forEach((row) => {
    if (!rubbingIds.has((row as Loss).rubbingId)) gaps.push(`损泐 ${row.id} 引用的拓本 ${(row as Loss).rubbingId} 不在包内`);
  });
  pkg.collections.seals.forEach((row) => {
    if (!rubbingIds.has((row as Seal).rubbingId)) gaps.push(`钤印 ${row.id} 引用的拓本 ${(row as Seal).rubbingId} 不在包内`);
  });
  pkg.collections.compares.forEach((row) => {
    const compare = row as Compare;
    if (!steleIds.has(compare.steleId)) gaps.push(`比对 ${row.id} 引用的碑刻 ${compare.steleId} 不在包内`);
    if (!rubbingIds.has(compare.rubbingIdA)) gaps.push(`比对 ${row.id} 引用的拓本 A ${compare.rubbingIdA} 不在包内`);
    if (!rubbingIds.has(compare.rubbingIdB)) gaps.push(`比对 ${row.id} 引用的拓本 B ${compare.rubbingIdB} 不在包内`);
  });
  return gaps;
}

/** 同一协作包是否已经合入过（重复导入不重复新增） */
export async function isPackageApplied(packageId: string): Promise<boolean> {
  return (await db.appliedPackages.get(packageId)) !== undefined;
}

/* ------------------------------ 三方对账 ------------------------------ */

function indexById(rows: SyncRecord[]): Map<string, SyncRecord> {
  return new Map(rows.map((row) => [row.id, row]));
}

export interface BuildPlanOptions {
  /** 冲突区中已存在的记录键（table:recordId），重复包不再重复报冲突 */
  existingConflictKeys?: ReadonlySet<string>;
}

/**
 * 按「共同基准 / 本机 / 协作包」对账，产出单边变化与未决冲突。
 * 对账规则：
 *  - 单边新增 / 单边修改 / 单边删除：自动应用；
 *  - 两边都改（含一改一删、各自新建同 id）：进入冲突区；
 *  - 已经躺在冲突区的同一记录，重复导入同一包不重复登记。
 */
export function buildMergePlan(pkg: SyncPackage, local: SyncCollections, options: BuildPlanOptions = {}): MergePlan {
  const changes: SyncChange[] = [];
  const conflicts: SyncConflict[] = [];
  const now = Date.now();
  const ctx: RelationContext = { steles: local.steles as Stele[], rubbings: local.rubbings as Rubbing[] };
  const existingConflictKeys = options.existingConflictKeys ?? new Set<string>();

  const counts = {} as MergePlan['counts'];

  SYNC_TABLES.forEach((table) => {
    const baseMap = indexById(pkg.baseline[table]);
    const localMap = indexById(local[table]);
    const incomingMap = indexById(pkg.collections[table]);
    counts[table] = { local: localMap.size, incoming: incomingMap.size, base: baseMap.size };

    const ids = new Set<string>([...baseMap.keys(), ...localMap.keys(), ...incomingMap.keys()]);
    ids.forEach((id) => {
      const base = baseMap.get(id) ?? null;
      const localRow = localMap.get(id) ?? null;
      const incoming = incomingMap.get(id) ?? null;
      const localChanged = signature(localRow, table) !== signature(base, table);
      const incomingChanged = signature(incoming, table) !== signature(base, table);

      // 两边都没变（含两边一致删除）：不动作
      if (!localChanged && !incomingChanged) return;
      // 两边改出完全相同的业务结果（含两边一致删除）：已收敛。本机即该结果，无需再写
      if (localChanged && incomingChanged && contentSignature(localRow, table) === contentSignature(incoming, table)) {
        return;
      }
      // 两边都变且结果不同：冲突（已在冲突区的同一记录不重复登记）
      if (localChanged && incomingChanged && !existingConflictKeys.has(`${table}:${id}`)) {
        let kind: SyncConflictKind;
        if (!base) kind = 'create-create';
        else if (!localRow || !incoming) kind = 'modify-delete';
        else kind = 'modify-modify';
        const representative = incoming ?? localRow ?? base;
        conflicts.push({
          id: `conflict_${pkg.packageId}_${table}_${id}`,
          packageId: pkg.packageId,
          table,
          recordId: id,
          kind,
          base,
          local: localRow,
          incoming,
          steleId: representative
            ? anchorOf(table, representative, ctx, { base, local: localRow, incoming })
            : null,
          label: describeLabel(table, representative, ctx),
          createdAt: now,
          updatedAt: now,
        });
        return;
      }
      // 仅协作包侧变化：自动应用（新增 / 修改 / 删除）
      // 但若该记录已经躺在冲突区（同一包重复导入），不再重复生成变化或冲突
      if (incomingChanged && !localChanged && !existingConflictKeys.has(`${table}:${id}`)) {
        changes.push({
          table,
          recordId: id,
          action: incoming ? 'upsert' : 'delete',
          record: incoming,
          nextBaseVersion: incoming?.baseVersion ?? (base?.baseVersion ?? 1),
          steleId: anchorOf(table, (incoming ?? base) as SyncRecord | null, ctx, { base, local: localRow, incoming }),
          label: describeLabel(table, incoming ?? base, ctx),
        });
      }
      // 仅本机变化：保留本机，不动作
    });
  });

  // 父记录单边删除、但其下仍有未决（或本次双边）冲突的子记录时，不沿关系直接级联，
  // 沿「损泐/钤印 → 拓本 → 碑刻」、「比对 → 碑刻」自底向上把父删除升级为「一改一删」冲突，
  // 交由人工选择，避免误删前人尚在冲突中的内容。
  const conflictKeys = new Set(conflicts.map((conflict) => `${conflict.table}:${conflict.recordId}`));
  existingConflictKeys.forEach((key) => conflictKeys.add(key));

  // 关系边：子表 → 取其父记录所在表 / 父 id
  const parentEdges: Array<{ child: SyncTable; parent: SyncTable; parentIdOf: (child: SyncRecord) => string }> = [
    { child: 'losses', parent: 'rubbings', parentIdOf: (child) => (child as Loss).rubbingId },
    { child: 'seals', parent: 'rubbings', parentIdOf: (child) => (child as Seal).rubbingId },
    { child: 'rubbings', parent: 'steles', parentIdOf: (child) => (child as Rubbing).steleId },
    { child: 'compares', parent: 'steles', parentIdOf: (child) => (child as Compare).steleId },
  ];

  const deleteChangeByKey = new Map(changes.filter((c) => c.action === 'delete').map((c) => [`${c.table}:${c.recordId}`, c]));
  const blockedChangeIds = new Set<string>();

  const promoteParent = (parentTable: SyncTable, parentId: string): void => {
    const key = `${parentTable}:${parentId}`;
    const change = deleteChangeByKey.get(key);
    if (!change || blockedChangeIds.has(key)) return;
    blockedChangeIds.add(key);
    const baseRecord = pkg.baseline[parentTable].find((row) => row.id === parentId) ?? null;
    const localRecord = local[parentTable].find((row) => row.id === parentId) ?? null;
    if (!conflicts.some((conflict) => conflict.table === parentTable && conflict.recordId === parentId)) {
      conflicts.push({
        id: `conflict_${pkg.packageId}_${parentTable}_${parentId}`,
        packageId: pkg.packageId,
        table: parentTable,
        recordId: parentId,
        kind: 'modify-delete',
        base: baseRecord,
        local: localRecord,
        incoming: null,
        steleId:
          parentTable === 'steles'
            ? parentId
            : localRecord
              ? anchorOf(parentTable, localRecord, ctx)
              : change.steleId,
        label: change.label,
        createdAt: now,
        updatedAt: now,
      });
    }
    // 继续向上：父拓本也被删，则其所属碑刻的删除同样升级
    parentEdges
      .filter((edge) => edge.child === parentTable)
      .forEach((edge) => {
        const refRecord = localRecord ?? baseRecord;
        if (refRecord) promoteParent(edge.parent, edge.parentIdOf(refRecord));
      });
  };

  // 对每个仍在冲突区的子记录，若其父记录被单边删除，则自底向上升级
  const allConflictRecords = (table: SyncTable): SyncRecord[] => {
    const fromConflicts = conflicts.filter((c) => c.table === table).map((c) => c.incoming ?? c.local ?? c.base).filter(Boolean) as SyncRecord[];
    const fromExisting: SyncRecord[] = [];
    existingConflictKeys.forEach((key) => {
      const [ct, id] = key.split(':') as [SyncTable, string];
      if (ct !== table) return;
      const row = local[table].find((r) => r.id === id) ?? pkg.collections[table].find((r) => r.id === id);
      if (row) fromExisting.push(row);
    });
    return [...fromConflicts, ...fromExisting];
  };

  parentEdges.forEach(({ child, parent, parentIdOf }) => {
    allConflictRecords(child).forEach((childRecord) => promoteParent(parent, parentIdOf(childRecord)));
  });

  const safeChanges = blockedChangeIds.size === 0 ? changes : changes.filter((change) => !blockedChangeIds.has(`${change.table}:${change.recordId}`));

  return {
    packageId: pkg.packageId,
    producer: pkg.producer,
    exportedAt: pkg.exportedAt,
    baseAt: pkg.baselineAt,
    changes: safeChanges,
    conflicts,
    counts,
  };
}

function describeLabel(table: SyncTable, record: SyncRecord | null, ctx: RelationContext): string {
  if (!record) return '已删除记录';
  // 冲突 / 变化的锚点优先使用包内冗余 steleId
  return recordLabel(table, record, {
    steles: ctx.steles,
    rubbings: ctx.rubbings,
  });
}

/* ------------------------------ 应用对账结果 ------------------------------ */

const TABLE_KEYS: Record<SyncTable, 'steles' | 'rubbings' | 'losses' | 'seals' | 'compares'> = {
  steles: 'steles',
  rubbings: 'rubbings',
  losses: 'losses',
  seals: 'seals',
  compares: 'compares',
};

function toDelete(change: SyncChange): boolean {
  return change.action === 'delete';
}

/**
 * 应用单边变化并登记未决冲突。
 * 全程在单个读写事务内：任何一步抛错，IndexedDB 整体回滚到导入前状态。
 * 碑刻 / 拓本的单边删除沿业务关系级联；冲突区涉及的子记录予以保留。
 */
export async function applyMergePlan(plan: MergePlan): Promise<void> {
  const now = Date.now();

  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.syncConflicts, db.appliedPackages, db.syncBaseline],
    async () => {
      // 级联保护范围：本次新冲突 + 此前已留在冲突区的未决记录
      const pendingConflictKey = new Set(plan.conflicts.map((conflict) => `${conflict.table}:${conflict.recordId}`));
      (await db.syncConflicts.toArray()).forEach((row) => pendingConflictKey.add(`${row.table}:${row.recordId}`));

      // 1) 碑刻删除（沿业务关系级联，保护冲突区记录）
      const deletedSteleChanges = plan.changes.filter((c) => c.table === 'steles' && toDelete(c));
      for (const change of deletedSteleChanges) {
        const rubbingRows = await db.rubbings.where('steleId').equals(change.recordId).toArray();
        const rubbingIds = rubbingRows.map((row) => row.id);
        const protectedChildren = async (table: SyncTable, ids: string[]): Promise<string[]> => {
          const rows = ids.length === 0 ? [] : await (db[TABLE_KEYS[table]] as typeof db.losses).where('rubbingId').anyOf(ids).toArray();
          return rows.filter((row) => !pendingConflictKey.has(`${table}:${row.id}`)).map((row) => row.id);
        };
        if (rubbingIds.length > 0) {
          const lossIds = await protectedChildren('losses', rubbingIds);
          const sealIds = await protectedChildren('seals', rubbingIds);
          if (lossIds.length > 0) await db.losses.bulkDelete(lossIds);
          if (sealIds.length > 0) await db.seals.bulkDelete(sealIds);
        }
        const compareRows = await db.compares.where('steleId').equals(change.recordId).toArray();
        const compareIds = compareRows.filter((row) => !pendingConflictKey.has(`compares:${row.id}`)).map((row) => row.id);
        await db.rubbings
          .where('steleId')
          .equals(change.recordId)
          .filter((row) => !pendingConflictKey.has(`rubbings:${row.id}`))
          .delete();
        if (compareIds.length > 0) await db.compares.bulkDelete(compareIds);
        await db.steles.delete(change.recordId);
      }

      // 2) 拓本删除（沿损泐 / 钤印 / 涉及比对级联，保护冲突区记录）
      const deletedRubbingChanges = plan.changes.filter((c) => c.table === 'rubbings' && toDelete(c));
      for (const change of deletedRubbingChanges) {
        const lossRows = await db.losses.where('rubbingId').equals(change.recordId).toArray();
        const sealRows = await db.seals.where('rubbingId').equals(change.recordId).toArray();
        const compareRows = await db.compares.toArray();
        const lossIds = lossRows.filter((row) => !pendingConflictKey.has(`losses:${row.id}`)).map((row) => row.id);
        const sealIds = sealRows.filter((row) => !pendingConflictKey.has(`seals:${row.id}`)).map((row) => row.id);
        const compareIds = compareRows
          .filter(
            (row) =>
              (row.rubbingIdA === change.recordId || row.rubbingIdB === change.recordId) &&
              !pendingConflictKey.has(`compares:${row.id}`),
          )
          .map((row) => row.id);
        if (lossIds.length > 0) await db.losses.bulkDelete(lossIds);
        if (sealIds.length > 0) await db.seals.bulkDelete(sealIds);
        if (compareIds.length > 0) await db.compares.bulkDelete(compareIds);
        await db.rubbings.delete(change.recordId);
      }

      // 3) 其余删除（损泐 / 钤印 / 比对）
      const otherDeletes = plan.changes.filter((c) => c.table !== 'steles' && c.table !== 'rubbings' && toDelete(c));
      for (const change of otherDeletes) {
        await (db[TABLE_KEYS[change.table]] as typeof db.losses).delete(change.recordId);
      }

      // 4) 新增 / 修改：父表优先，落库时统一基准版本、剥掉冗余锚点
      const upserts = plan.changes.filter((c) => c.action === 'upsert' && c.record);
      for (const table of SYNC_TABLES) {
        const tableUpserts = upserts.filter((change) => change.table === table);
        if (tableUpserts.length === 0) continue;
        const rows = tableUpserts.map((change) => {
          const clean = stripAnchor(table, change.record as SyncRecord) as SyncRecord & { baseVersion: number };
          return { ...clean, baseVersion: change.nextBaseVersion };
        });
        await (db[TABLE_KEYS[table]] as typeof db.losses).bulkPut(rows as never[]);
      }

      // 5) 未决冲突写入冲突区（跨次导入继续保留；同包同记录幂等）
      if (plan.conflicts.length > 0) await db.syncConflicts.bulkPut(plan.conflicts);

      // 6) 登记已合入包，重复导入同一包不再新增
      const applied: AppliedPackage = {
        id: plan.packageId,
        producer: plan.producer,
        appliedAt: now,
        exportedAt: plan.exportedAt,
      };
      await db.appliedPackages.put(applied);

      // 7) 重建共同基准：以应用后的业务数据为准；仍在冲突区（含历史未决）的记录保留旧基准值
      const merged = await readBusinessCollections();
      const priorBaseline = (await db.syncBaseline.get(BASELINE_DOC_ID))?.collections;
      const unresolved = new Set<string>();
      (await db.syncConflicts.toArray()).forEach((conflict) => unresolved.add(`${conflict.table}:${conflict.recordId}`));
      const nextCollections: SyncCollections = { ...merged };
      SYNC_TABLES.forEach((table) => {
        const byId = new Map(merged[table].map((row) => [row.id, row]));
        unresolved.forEach((key) => {
          const [conflictTable, recordId] = key.split(':') as [SyncTable, string];
          if (conflictTable !== table) return;
          const previous = priorBaseline?.[table].find((row) => row.id === recordId);
          if (previous && !byId.has(recordId)) byId.set(recordId, previous);
        });
        nextCollections[table] = Array.from(byId.values());
      });
      await db.syncBaseline.put({ id: BASELINE_DOC_ID, updatedAt: now, collections: nextCollections });
    },
  );
}

/* ------------------------------ 冲突解决 ------------------------------ */

export type ConflictResolution = 'local' | 'incoming';

/**
 * 人工解决单条未决冲突：
 *  - local：采用本机工作库的值（保留记录 / 维持本机删除）；
 *  - incoming：采用协作包的值（写包侧记录 / 执行该侧删除，沿业务关系级联）。
 * 选定后从冲突区移除，并刷新该记录的共同基准。整段事务，失败恢复原状。
 */
export async function resolveConflict(conflictId: string, resolution: ConflictResolution): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.syncConflicts, db.syncBaseline],
    async () => {
      const conflict = await db.syncConflicts.get(conflictId);
      if (!conflict) return;
      const chosen = resolution === 'local' ? conflict.local : conflict.incoming;
      const cleanChosen = chosen ? (stripAnchor(conflict.table, chosen) as SyncRecord & { baseVersion: number }) : null;

      if (cleanChosen) {
        await (db[TABLE_KEYS[conflict.table]] as typeof db.losses).put(cleanChosen as never);
      } else {
        // 选定的一侧是「删除」：沿业务关系级联
        if (conflict.table === 'steles') {
          await deleteSteleInsideTx(conflict.recordId);
        } else if (conflict.table === 'rubbings') {
          await deleteRubbingInsideTx(conflict.recordId);
        } else {
          await (db[TABLE_KEYS[conflict.table]] as typeof db.losses).delete(conflict.recordId);
        }
      }
      await db.syncConflicts.delete(conflictId);

      // 刷新共同基准中该记录（已删除则移出基准）；基准只保留各表自身字段，剥掉冗余锚点
      const doc = await db.syncBaseline.get(BASELINE_DOC_ID);
      const collections: SyncCollections = doc ? ({ ...doc.collections } as SyncCollections) : {
        steles: [],
        rubbings: [],
        losses: [],
        seals: [],
        compares: [],
      };
      collections[conflict.table] = cleanChosen
        ? [...collections[conflict.table].filter((row) => row.id !== conflict.recordId), cleanChosen]
        : collections[conflict.table].filter((row) => row.id !== conflict.recordId);
      await db.syncBaseline.put({ id: BASELINE_DOC_ID, updatedAt: Date.now(), collections });
    },
  );
}

async function deleteSteleInsideTx(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  if (rubbingIds.length > 0) {
    await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
    await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
  }
  await db.rubbings.where('steleId').equals(steleId).delete();
  await db.compares.where('steleId').equals(steleId).delete();
  await db.steles.delete(steleId);
}

async function deleteRubbingInsideTx(rubbingId: string): Promise<void> {
  await db.losses.where('rubbingId').equals(rubbingId).delete();
  await db.seals.where('rubbingId').equals(rubbingId).delete();
  const compares = await db.compares.toArray();
  const ids = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId).map((row) => row.id);
  if (ids.length > 0) await db.compares.bulkDelete(ids);
  await db.rubbings.delete(rubbingId);
}

export type { BaselineDoc };
