/**
 * 离线协作包：导出共同基准 + 墓碑，导入按两侧记录三方对账
 * - 只应用单边变化；同一记录两边都改过（或删改相抵）→ 冲突区
 * - 删除沿业务关系传播：删碑刻 / 拓本时本机改过的子记录进同一冲突组
 * - 引用不全 / 写入失败 → 整单事务回滚，恢复导入前状态；未决冲突继续保留
 * - packageId 登记保证重复导入同一包不重复新增
 */
import { DB_NAME, DB_SCHEMA_VERSION, db, getOrigin } from './db';
import {
  conflictKey,
  SYNC_COLLECTIONS,
  tombstoneKey,
  type AnyBusinessRecord,
  type PackageLedgerEntry,
  type SyncConflict,
  type SyncConflictKind,
  type SyncEntityName,
  type SyncPackage,
  type Tombstone,
  type VersionedRecord,
} from '@/types/sync';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';

/* ------------------------------ 协作包导出 ------------------------------ */

function createPackageId(): string {
  return `pkg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 导出协作包：每张业务记录携带当前版本与共同基准版本，并带上全部删除墓碑。
 * 整包即「本机工作库现状 + 删除事实」，对侧据此做三方对账。
 */
export async function buildCollabPackage(): Promise<SyncPackage> {
  const [steles, rubbings, losses, seals, compares, tombstones] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
    db.tombstones.toArray(),
  ]);
  return {
    app: DB_NAME,
    kind: 'collab',
    packageId: createPackageId(),
    origin: getOrigin(),
    exportedAt: new Date().toISOString(),
    schemaVersion: DB_SCHEMA_VERSION,
    steles,
    rubbings,
    losses,
    seals,
    compares,
    tombstones,
  };
}

/** 校验协作包结构，返回错误文案（空串表示通过） */
export function validateSyncPackage(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const pkg = input as Partial<SyncPackage>;
  if (pkg.app !== DB_NAME) return `协作包不属于本项目（app=${String(pkg.app)}）`;
  if (pkg.kind !== 'collab') return '该文件不是协作包（缺少 kind=collab 标识）';
  if (typeof pkg.packageId !== 'string' || pkg.packageId.length === 0) return '协作包缺少 packageId';
  if (typeof pkg.origin !== 'string' || pkg.origin.length === 0) return '协作包缺少来源标识';
  for (const entity of SYNC_COLLECTIONS) {
    if (!Array.isArray(pkg[entity])) return `协作包缺少 ${entity} 集合`;
  }
  if (!Array.isArray(pkg.tombstones)) return '协作包缺少 tombstones 集合';
  if (typeof pkg.schemaVersion !== 'number' || pkg.schemaVersion < 3) {
    return `协作包来自旧结构版本（v${String(pkg.schemaVersion)}），不含协作基准与墓碑，请对方升级后重新导出`;
  }
  if (pkg.schemaVersion > DB_SCHEMA_VERSION) {
    return `协作包来自更新的结构版本（v${pkg.schemaVersion} > 本机 v${DB_SCHEMA_VERSION}），请先升级本工具`;
  }
  return '';
}

/* ------------------------------ 三方对账 ------------------------------ */

interface EntityBuckets {
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
}

type EntityBucketMap = Record<SyncEntityName, Map<string, AnyBusinessRecord>>;

function toBucketMap(buckets: EntityBuckets): EntityBucketMap {
  return {
    steles: new Map(buckets.steles.map((row) => [row.id, row])),
    rubbings: new Map(buckets.rubbings.map((row) => [row.id, row])),
    losses: new Map(buckets.losses.map((row) => [row.id, row])),
    seals: new Map(buckets.seals.map((row) => [row.id, row])),
    compares: new Map(buckets.compares.map((row) => [row.id, row])),
  };
}

/** 记录相对共同基准是否改过：version > baseVersion */
function changedFromBase(row: VersionedRecord): boolean {
  return row.version > row.baseVersion;
}

/** 合并后对齐版本：以较高的当前版本为新版本，基准取双方基准的较大值 */
function mergeVersions(local: VersionedRecord, remote: VersionedRecord): { version: number; baseVersion: number } {
  return {
    version: Math.max(local.version, remote.version),
    baseVersion: Math.max(local.baseVersion, remote.baseVersion),
  };
}

/** 远端单边新增落地：版本与基准都取远端版本（本机此前没有该记录，不构成待同步差异） */
function adoptRemote(remote: AnyBusinessRecord): AnyBusinessRecord {
  return { ...remote, version: remote.version, baseVersion: remote.version };
}

export interface MergePlan {
  /** 需要 upsert 的业务记录（单边新增 / 单边修改 / 无变化取高版本对齐） */
  upserts: Partial<Record<SyncEntityName, AnyBusinessRecord[]>>;
  /** 需要删除的业务记录 id（单边删除，且无未决冲突拦截） */
  deletes: Partial<Record<SyncEntityName, string[]>>;
  /** 需要合并写入的墓碑（含对侧新墓碑与双方删除后保留高版本者） */
  tombstonesToPut: Tombstone[];
  /** 本次新产生的冲突（同记录已有未决冲突则不覆盖） */
  newConflicts: SyncConflict[];
  /** 被未决冲突拦截、本次不处理的记录 id 集合（key 为 conflictKey） */
  blockedKeys: Set<string>;
}

/**
 * 纯计算：把本机工作库与协作包按共同基准对账。
 * 不触碰数据库，便于先校验完整性再在单事务内落地。
 */
export function planMerge(
  local: EntityBuckets,
  localTombstoneRows: Tombstone[],
  pkg: SyncPackage,
  existingConflicts: SyncConflict[],
): MergePlan {
  const localMap = toBucketMap(local);
  const remoteMap = toBucketMap(pkg);
  const localTombstones = new Map<string, Tombstone>();
  localTombstoneRows.forEach((tomb) => localTombstones.set(tomb.id, tomb));
  const remoteTombstones = new Map<string, Tombstone>();
  pkg.tombstones.forEach((tomb) => remoteTombstones.set(tomb.id, tomb));

  const upserts: Partial<Record<SyncEntityName, AnyBusinessRecord[]>> = {};
  const deletes: Partial<Record<SyncEntityName, string[]>> = {};
  const tombstonesToPut: Tombstone[] = [];
  const newConflicts: SyncConflict[] = [];
  const blockedKeys = new Set<string>();
  const existingConflictKeys = new Set(existingConflicts.map((conflict) => conflict.id));
  const consumedRemoteTombstones = new Set<string>();

  const pushUpsert = (entity: SyncEntityName, row: AnyBusinessRecord): void => {
    (upserts[entity] ??= []).push(row);
  };
  const pushDelete = (entity: SyncEntityName, id: string): void => {
    (deletes[entity] ??= []).push(id);
  };
  /** 自动级联删除时：优先采纳对侧墓碑；对侧没带则按本机记录补建，删除事实必须落本机 */
  const adoptOrBuildTomb = (entity: SyncEntityName, row: AnyBusinessRecord | undefined): void => {
    if (!row) return;
    const id = tombstoneKey(entity, row.id);
    consumedRemoteTombstones.add(id);
    const remote = remoteTombstones.get(id);
    if (remote) {
      tombstonesToPut.push(remote);
    } else {
      tombstonesToPut.push({
        id,
        entity,
        recordId: row.id,
        version: row.version,
        origin: pkg.origin,
        deletedAt: Date.now(),
      });
    }
  };
  const pushConflict = (
    entity: SyncEntityName,
    recordId: string,
    kind: SyncConflictKind,
    localValue: AnyBusinessRecord | null,
    remoteValue: AnyBusinessRecord | null,
    groupId: string,
  ): void => {
    const key = conflictKey(entity, recordId);
    blockedKeys.add(key);
    consumedRemoteTombstones.add(tombstoneKey(entity, recordId));
    if (existingConflictKeys.has(key)) return;
    newConflicts.push({
      id: key,
      groupId,
      entity,
      recordId,
      kind,
      localValue,
      remoteValue,
      packageId: pkg.packageId,
      origin: pkg.origin,
      createdAt: Date.now(),
    });
  };

  /* ---------- 远端删除碑刻：沿业务关系检查本机子树 ---------- */
  remoteTombstones.forEach((tomb) => {
    if (tomb.entity !== 'steles') return;
    const steleId = tomb.recordId;
    const localStele = localMap.steles.get(steleId);
    const subtreeRubbings = local.rubbings.filter((row) => row.steleId === steleId);
    const rubbingIds = new Set(subtreeRubbings.map((row) => row.id));
    const subtreeLosses = local.losses.filter((row) => rubbingIds.has(row.rubbingId));
    const subtreeSeals = local.seals.filter((row) => rubbingIds.has(row.rubbingId));
    const subtreeCompares = local.compares.filter((row) => row.steleId === steleId);

    const groupId = `del-stele-${steleId}-${pkg.packageId}`;
    // 本机改过的现存成员（碑刻本身、子拓本及其损泐 / 钤印、比对记录）。
    // 是否拦截只看本机一侧：远端自带的子级墓碑是同一次级联的冗余删除事实，不算本机改动。
    const edited: Array<{ entity: SyncEntityName; row: AnyBusinessRecord }> = [];
    if (localStele && changedFromBase(localStele)) edited.push({ entity: 'steles', row: localStele });
    subtreeRubbings
      .filter((row) => changedFromBase(row))
      .forEach((row) => edited.push({ entity: 'rubbings', row }));
    subtreeLosses
      .filter((row) => changedFromBase(row))
      .forEach((row) => edited.push({ entity: 'losses', row }));
    subtreeSeals
      .filter((row) => changedFromBase(row))
      .forEach((row) => edited.push({ entity: 'seals', row }));
    subtreeCompares
      .filter((row) => changedFromBase(row))
      .forEach((row) => edited.push({ entity: 'compares', row }));

    // 本机在被删碑刻下新增的拓本（远端墓碑与远端活记录都没有）
    const createdRubbings = subtreeRubbings.filter(
      (row) =>
        !remoteMap.rubbings.has(row.id) && !remoteTombstones.has(tombstoneKey('rubbings', row.id)),
    );
    const createdRubbingIds = new Set(createdRubbings.map((row) => row.id));
    const createdChildren: Array<{ entity: SyncEntityName; row: AnyBusinessRecord }> = [];
    createdRubbings.forEach((row) => createdChildren.push({ entity: 'rubbings', row }));
    local.losses
      .filter((row) => createdRubbingIds.has(row.rubbingId) && !remoteTombstones.has(tombstoneKey('losses', row.id)))
      .forEach((row) => createdChildren.push({ entity: 'losses', row }));
    local.seals
      .filter((row) => createdRubbingIds.has(row.rubbingId) && !remoteTombstones.has(tombstoneKey('seals', row.id)))
      .forEach((row) => createdChildren.push({ entity: 'seals', row }));

    const blocking = edited.length > 0 || createdChildren.length > 0;
    consumedRemoteTombstones.add(tomb.id);

    if (blocking) {
      // 整棵子树进同一冲突组：选「协作包值」=整体删除，选「本机值」=整体保留
      pushConflict(
        'steles',
        steleId,
        localStele && changedFromBase(localStele) ? 'remote-delete-local-edit' : 'remote-delete-local-create',
        localStele ?? null,
        null,
        groupId,
      );
      edited.forEach(({ entity, row }) => {
        pushConflict(entity, row.id, 'remote-delete-local-edit', row, remoteMap[entity].get(row.id) ?? null, groupId);
      });
      createdChildren.forEach(({ entity, row }) => {
        pushConflict(entity, row.id, 'remote-delete-local-create', row, null, groupId);
      });
      // 子树其余未改成员及墓碑也挂在本组（删除或保留均由组决议统一处理）
      subtreeRubbings
        .filter((row) => !blockedKeys.has(conflictKey('rubbings', row.id)))
        .forEach((row) => pushConflict('rubbings', row.id, 'remote-delete-local-create', row, null, groupId));
      subtreeLosses
        .filter((row) => !blockedKeys.has(conflictKey('losses', row.id)))
        .forEach((row) => pushConflict('losses', row.id, 'remote-delete-local-create', row, null, groupId));
      subtreeSeals
        .filter((row) => !blockedKeys.has(conflictKey('seals', row.id)))
        .forEach((row) => pushConflict('seals', row.id, 'remote-delete-local-create', row, null, groupId));
      subtreeCompares
        .filter((row) => !blockedKeys.has(conflictKey('compares', row.id)))
        .forEach((row) => pushConflict('compares', row.id, 'remote-delete-local-create', row, null, groupId));
      subtreeRubbings.forEach((row) => consumedRemoteTombstones.add(tombstoneKey('rubbings', row.id)));
      subtreeLosses.forEach((row) => consumedRemoteTombstones.add(tombstoneKey('losses', row.id)));
      subtreeSeals.forEach((row) => consumedRemoteTombstones.add(tombstoneKey('seals', row.id)));
      subtreeCompares.forEach((row) => consumedRemoteTombstones.add(tombstoneKey('compares', row.id)));
    } else {
      // 无本机改动：沿关系单边删除整棵子树，同时接纳 / 补建全部删除墓碑
      if (localStele) {
        pushDelete('steles', steleId);
        adoptOrBuildTomb('steles', localStele);
      }
      subtreeRubbings.forEach((row) => {
        pushDelete('rubbings', row.id);
        adoptOrBuildTomb('rubbings', row);
      });
      subtreeLosses.forEach((row) => {
        pushDelete('losses', row.id);
        adoptOrBuildTomb('losses', row);
      });
      subtreeSeals.forEach((row) => {
        pushDelete('seals', row.id);
        adoptOrBuildTomb('seals', row);
      });
      subtreeCompares.forEach((row) => {
        pushDelete('compares', row.id);
        adoptOrBuildTomb('compares', row);
      });
    }
  });

  /* ---------- 远端删除拓本：沿关系检查损泐 / 钤印 / 比对 ---------- */
  remoteTombstones.forEach((tomb) => {
    if (tomb.entity !== 'rubbings' || consumedRemoteTombstones.has(tomb.id)) return;
    const rubbingId = tomb.recordId;
    const localRubbing = localMap.rubbings.get(rubbingId);
    const childLosses = local.losses.filter((row) => row.rubbingId === rubbingId);
    const childSeals = local.seals.filter((row) => row.rubbingId === rubbingId);
    const childCompares = local.compares.filter(
      (row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId,
    );

    const groupId = `del-rubbing-${rubbingId}-${pkg.packageId}`;
    const edited: Array<{ entity: SyncEntityName; row: AnyBusinessRecord }> = [];
    if (localRubbing && changedFromBase(localRubbing)) edited.push({ entity: 'rubbings', row: localRubbing });
    childLosses
      .filter((row) => changedFromBase(row))
      .forEach((row) => edited.push({ entity: 'losses', row }));
    childSeals
      .filter((row) => changedFromBase(row))
      .forEach((row) => edited.push({ entity: 'seals', row }));
    childCompares
      .filter((row) => changedFromBase(row))
      .forEach((row) => edited.push({ entity: 'compares', row }));

    consumedRemoteTombstones.add(tomb.id);
    if (edited.length > 0) {
      pushConflict(
        'rubbings',
        rubbingId,
        localRubbing && changedFromBase(localRubbing) ? 'remote-delete-local-edit' : 'remote-delete-local-create',
        localRubbing ?? null,
        null,
        groupId,
      );
      edited
        .filter((item) => item.row.id !== rubbingId)
        .forEach(({ entity, row }) => {
          pushConflict(entity, row.id, 'remote-delete-local-edit', row, remoteMap[entity].get(row.id) ?? null, groupId);
        });
      childLosses
        .filter((row) => !blockedKeys.has(conflictKey('losses', row.id)))
        .forEach((row) => pushConflict('losses', row.id, 'remote-delete-local-create', row, null, groupId));
      childSeals
        .filter((row) => !blockedKeys.has(conflictKey('seals', row.id)))
        .forEach((row) => pushConflict('seals', row.id, 'remote-delete-local-create', row, null, groupId));
      childCompares
        .filter((row) => !blockedKeys.has(conflictKey('compares', row.id)))
        .forEach((row) => pushConflict('compares', row.id, 'remote-delete-local-create', row, null, groupId));
      childLosses.forEach((row) => consumedRemoteTombstones.add(tombstoneKey('losses', row.id)));
      childSeals.forEach((row) => consumedRemoteTombstones.add(tombstoneKey('seals', row.id)));
      childCompares.forEach((row) => consumedRemoteTombstones.add(tombstoneKey('compares', row.id)));
    } else {
      if (localRubbing) {
        pushDelete('rubbings', rubbingId);
        adoptOrBuildTomb('rubbings', localRubbing);
      }
      childLosses.forEach((row) => {
        pushDelete('losses', row.id);
        adoptOrBuildTomb('losses', row);
      });
      childSeals.forEach((row) => {
        pushDelete('seals', row.id);
        adoptOrBuildTomb('seals', row);
      });
      childCompares.forEach((row) => {
        pushDelete('compares', row.id);
        adoptOrBuildTomb('compares', row);
      });
    }
  });

  /* ---------- 叶子记录（损泐 / 钤印 / 比对）远端删除 ---------- */
  (['losses', 'seals', 'compares'] as const).forEach((entity) => {
    remoteTombstones.forEach((tomb) => {
      if (tomb.entity !== entity || consumedRemoteTombstones.has(tomb.id)) return;
      consumedRemoteTombstones.add(tomb.id);
      const localRow = localMap[entity].get(tomb.recordId);
      if (!localRow) return; // 两边都删过 / 本机从无：墓碑在统一 pass 合并
      if (changedFromBase(localRow)) {
        pushConflict(
          entity,
          tomb.recordId,
          'remote-delete-local-edit',
          localRow,
          remoteMap[entity].get(tomb.recordId) ?? null,
          `del-${entity}-${tomb.recordId}-${pkg.packageId}`,
        );
      } else {
        pushDelete(entity, tomb.recordId);
        adoptOrBuildTomb(entity, localRow);
      }
    });
  });

  /* ---------- 活记录逐表对账 ---------- */
  SYNC_COLLECTIONS.forEach((entity) => {
    remoteMap[entity].forEach((remote, id) => {
      if (blockedKeys.has(conflictKey(entity, id))) return;
      const localRow = localMap[entity].get(id);
      const localDeleted = localTombstones.has(tombstoneKey(entity, id));
      if (localDeleted) {
        // 本机已删、协作包改了：进冲突区，由馆员选恢复或维持删除
        pushConflict(
          entity,
          id,
          'local-delete-remote-edit',
          null,
          remote,
          `del-local-${entity}-${id}`,
        );
        return;
      }
      if (!localRow) {
        // 单边新增（含此前对侧墓碑被新活记录取代的复活情形）
        pushUpsert(entity, adoptRemote(remote));
        return;
      }
      const localChanged = changedFromBase(localRow);
      const remoteChanged = changedFromBase(remote);
      if (localChanged && remoteChanged) {
        // 同一记录两边都改过：冲突区，分别保留本机工作库与协作包的值
        pushConflict(
          entity,
          id,
          'modify-modify',
          localRow,
          remote,
          `edit-${entity}-${id}`,
        );
        return;
      }
      if (remoteChanged) {
        // 单边变化：只应用协作包一侧，对齐到远端版本
        pushUpsert(entity, { ...remote, baseVersion: remote.version });
        return;
      }
      if (localChanged) {
        // 只本机改过：保留本机，仅把基准抬到双方基准的较大值
        pushUpsert(entity, {
          ...localRow,
          ...mergeVersions(localRow, remote),
        });
        return;
      }
      // 两边都没改：版本对齐（通常相等），不写多余数据
      const merged = mergeVersions(localRow, remote);
      if (merged.version !== localRow.version || merged.baseVersion !== localRow.baseVersion) {
        pushUpsert(entity, { ...localRow, ...merged });
      }
    });
  });

  /* ---------- 墓碑统一 pass：未被冲突 / 子树处理消费的远端墓碑合并入本机 ---------- */
  remoteTombstones.forEach((tomb, id) => {
    if (consumedRemoteTombstones.has(id)) return;
    if (blockedKeys.has(id)) return;
    tombstonesToPut.push(tomb);
  });

  return { upserts, deletes, tombstonesToPut, newConflicts, blockedKeys };
}

/* ------------------------------ 引用完整性 ------------------------------ */

/** 拆分冲突主键 `entity:recordId` */
function splitKey(key: string): [SyncEntityName, string] {
  const index = key.indexOf(':');
  return [key.slice(0, index) as SyncEntityName, key.slice(index + 1)];
}

/* ------------------------------ 导入落地 ------------------------------ */

export interface ImportCollabResult {
  packageId: string;
  origin: string;
  appliedCount: number;
  conflictCount: number;
  skipped: boolean;
}

/**
 * 导入协作包：登记查重 → 三方对账 → 引用完整性校验 → 单事务写入。
 * 任一环节失败（含事务异常）都不写入业务数据，恢复导入前状态；
 * 未决冲突落 conflicts 表继续保留，同记录不覆盖上一批未决值。
 */
export async function importCollabPackage(pkg: SyncPackage): Promise<ImportCollabResult> {
  const existed = await db.packageLedger.get(pkg.packageId);
  if (existed) {
    return {
      packageId: pkg.packageId,
      origin: pkg.origin,
      appliedCount: 0,
      conflictCount: 0,
      skipped: true,
    };
  }

  const local: EntityBuckets = {
    steles: await db.steles.toArray(),
    rubbings: await db.rubbings.toArray(),
    losses: await db.losses.toArray(),
    seals: await db.seals.toArray(),
    compares: await db.compares.toArray(),
  };
  const existingConflicts = await db.conflicts.toArray();
  const localTombstoneRows = await db.tombstones.toArray();
  const plan = planMerge(local, localTombstoneRows, pkg, existingConflicts);

  // 远端新增 / 远端改的子记录若引用了「本机已删」的上级（本机有墓碑、包内也没带活上级），
  // 属于删改相抵：进冲突区由馆员选择，不按引用不全整单回滚。
  const localTombstoneSet = new Set(localTombstoneRows.map((tomb) => tomb.id));
  const remoteSteleIds = new Set(pkg.steles.map((row) => row.id));
  const remoteRubbingIds = new Set(pkg.rubbings.map((row) => row.id));
  const orphanConflicts: SyncConflict[] = [];
  const orphanKeys = new Set<string>();
  /** 引用本机已删上级的远端新增：从自动落地集合中剔除，只在冲突区保留对侧值 */
  const orphanBlockedKeys = new Set<string>();
  const existingConflictIds = new Set(existingConflicts.map((conflict) => conflict.id));
  const pushOrphan = (
    entity: SyncEntityName,
    record: AnyBusinessRecord,
    parentEntity: SyncEntityName,
    parentId: string,
  ): void => {
    const key = conflictKey(entity, record.id);
    if (plan.blockedKeys.has(key) || orphanKeys.has(key)) return;
    orphanKeys.add(key);
    const localRow =
      entity === 'steles'
        ? local.steles.find((row) => row.id === record.id)
        : entity === 'rubbings'
          ? local.rubbings.find((row) => row.id === record.id)
          : entity === 'losses'
            ? local.losses.find((row) => row.id === record.id)
            : entity === 'seals'
              ? local.seals.find((row) => row.id === record.id)
              : local.compares.find((row) => row.id === record.id);
    // 本机没有活记录说明它是远端单边新增，必须从自动 upsert 中剔除
    if (!localRow) orphanBlockedKeys.add(key);
    if (existingConflictIds.has(key)) return;
    orphanConflicts.push({
      id: key,
      groupId: `orphan-${parentEntity}-${parentId}-${record.id}`,
      entity,
      recordId: record.id,
      kind: 'local-delete-remote-edit',
      localValue: localRow ?? null,
      remoteValue: record,
      packageId: pkg.packageId,
      origin: pkg.origin,
      createdAt: Date.now(),
    });
  };
  pkg.rubbings.forEach((row) => {
    if (localTombstoneSet.has(tombstoneKey('steles', row.steleId)) && !remoteSteleIds.has(row.steleId)) {
      pushOrphan('rubbings', row, 'steles', row.steleId);
    }
  });
  pkg.losses.forEach((row) => {
    if (localTombstoneSet.has(tombstoneKey('rubbings', row.rubbingId)) && !remoteRubbingIds.has(row.rubbingId)) {
      pushOrphan('losses', row, 'rubbings', row.rubbingId);
    }
  });
  pkg.seals.forEach((row) => {
    if (localTombstoneSet.has(tombstoneKey('rubbings', row.rubbingId)) && !remoteRubbingIds.has(row.rubbingId)) {
      pushOrphan('seals', row, 'rubbings', row.rubbingId);
    }
  });
  pkg.compares.forEach((row) => {
    if (
      (localTombstoneSet.has(tombstoneKey('steles', row.steleId)) && !remoteSteleIds.has(row.steleId)) ||
      (localTombstoneSet.has(tombstoneKey('rubbings', row.rubbingIdA)) && !remoteRubbingIds.has(row.rubbingIdA)) ||
      (localTombstoneSet.has(tombstoneKey('rubbings', row.rubbingIdB)) && !remoteRubbingIds.has(row.rubbingIdB))
    ) {
      pushOrphan('compares', row, 'steles', row.steleId);
    }
  });
  if (orphanConflicts.length > 0) {
    plan.newConflicts.push(...orphanConflicts);
    orphanKeys.forEach((key) => plan.blockedKeys.add(key));
  }
  // 远端单边新增的孤儿记录：从事务 upsert 中移除（选「协作包值」决议时才写入）
  SYNC_COLLECTIONS.forEach((entity) => {
    plan.upserts[entity] = (plan.upserts[entity] ?? []).filter(
      (row) => !orphanBlockedKeys.has(conflictKey(entity, row.id)),
    );
  });

  // 引用完整性：校验「将从协作包写入」的记录（远端新增 + 单边采用对侧值），
  // 其引用的上级必须能在本机现有活记录或协作包活记录中找到；本机原样保留的记录不参与。
  const referenceSteleIds = new Set<string>([
    ...local.steles.map((row) => row.id),
    ...pkg.steles.map((row) => row.id),
  ]);
  const referenceRubbingIds = new Set<string>([
    ...local.rubbings.map((row) => row.id),
    ...pkg.rubbings.map((row) => row.id),
  ]);
  // 上级若本次会被删除或处于未决冲突拦截，则引用必然悬空
  plan.deletes.steles?.forEach((id) => referenceSteleIds.delete(id));
  plan.deletes.rubbings?.forEach((id) => referenceRubbingIds.delete(id));
  plan.blockedKeys.forEach((key) => {
    const [entity, id] = splitKey(key);
    if (entity === 'steles') referenceSteleIds.delete(id);
    if (entity === 'rubbings') referenceRubbingIds.delete(id);
  });

  const integrityErrors: string[] = [];
  const remoteUpserts = {
    steles: plan.upserts.steles ?? [],
    rubbings: (plan.upserts.rubbings ?? []).filter((row) =>
      pkg.rubbings.some((remote) => remote.id === row.id),
    ),
    losses: (plan.upserts.losses ?? []).filter((row) => pkg.losses.some((remote) => remote.id === row.id)),
    seals: (plan.upserts.seals ?? []).filter((row) => pkg.seals.some((remote) => remote.id === row.id)),
    compares: (plan.upserts.compares ?? []).filter((row) =>
      pkg.compares.some((remote) => remote.id === row.id),
    ),
  };
  remoteUpserts.rubbings.forEach((row) => {
    const rubbing = row as Rubbing;
    if (!referenceSteleIds.has(rubbing.steleId)) {
      integrityErrors.push(
        `拓本 ${rubbing.id}（收藏号 ${rubbing.collectionNo || '未编'}）引用的碑刻 ${rubbing.steleId} 不在包内且本机已不存在`,
      );
    }
  });
  remoteUpserts.losses.forEach((row) => {
    const loss = row as Loss;
    if (!referenceRubbingIds.has(loss.rubbingId)) {
      integrityErrors.push(`损泐字位 ${loss.id}（第 ${loss.lineNo} 行）引用的拓本 ${loss.rubbingId} 不在包内且本机已不存在`);
    }
  });
  remoteUpserts.seals.forEach((row) => {
    const seal = row as Seal;
    if (!referenceRubbingIds.has(seal.rubbingId)) {
      integrityErrors.push(`钤印 ${seal.id}（${seal.sealText || '无印文'}）引用的拓本 ${seal.rubbingId} 不在包内且本机已不存在`);
    }
  });
  remoteUpserts.compares.forEach((row) => {
    const compare = row as Compare;
    if (!referenceSteleIds.has(compare.steleId)) {
      integrityErrors.push(`比对记录 ${compare.id}（${compare.date}）引用的碑刻 ${compare.steleId} 不在包内且本机已不存在`);
    }
    if (!referenceRubbingIds.has(compare.rubbingIdA)) {
      integrityErrors.push(`比对记录 ${compare.id}（${compare.date}）引用的 A 拓本 ${compare.rubbingIdA} 不在包内且本机已不存在`);
    }
    if (!referenceRubbingIds.has(compare.rubbingIdB)) {
      integrityErrors.push(`比对记录 ${compare.id}（${compare.date}）引用的 B 拓本 ${compare.rubbingIdB} 不在包内且本机已不存在`);
    }
  });
  if (integrityErrors.length > 0) {
    const error = new Error(`协作包引用不全，已取消导入并恢复导入前状态：\n${integrityErrors.slice(0, 8).join('\n')}`);
    throw error;
  }

  let appliedCount = 0;
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.tombstones, db.conflicts, db.packageLedger],
    async () => {
      const writeTable = async (entity: SyncEntityName): Promise<void> => {
        const rows = plan.upserts[entity] ?? [];
        const ids = plan.deletes[entity] ?? [];
        switch (entity) {
          case 'steles':
            if (rows.length > 0) await db.steles.bulkPut(rows as Stele[]);
            if (ids.length > 0) await db.steles.bulkDelete(ids);
            break;
          case 'rubbings':
            if (rows.length > 0) await db.rubbings.bulkPut(rows as Rubbing[]);
            if (ids.length > 0) await db.rubbings.bulkDelete(ids);
            break;
          case 'losses':
            if (rows.length > 0) await db.losses.bulkPut(rows as Loss[]);
            if (ids.length > 0) await db.losses.bulkDelete(ids);
            break;
          case 'seals':
            if (rows.length > 0) await db.seals.bulkPut(rows as Seal[]);
            if (ids.length > 0) await db.seals.bulkDelete(ids);
            break;
          case 'compares':
            if (rows.length > 0) await db.compares.bulkPut(rows as Compare[]);
            if (ids.length > 0) await db.compares.bulkDelete(ids);
            break;
        }
        appliedCount += rows.length + ids.length;
      };
      for (const entity of SYNC_COLLECTIONS) {
        await writeTable(entity);
      }
      if (plan.tombstonesToPut.length > 0) await db.tombstones.bulkPut(plan.tombstonesToPut);
      if (plan.newConflicts.length > 0) await db.conflicts.bulkPut(plan.newConflicts);

      const entry: PackageLedgerEntry = {
        packageId: pkg.packageId,
        origin: pkg.origin,
        importedAt: new Date().toISOString(),
        appliedCount,
        conflictCount: plan.newConflicts.length,
      };
      await db.packageLedger.put(entry);
    },
  );

  return {
    packageId: pkg.packageId,
    origin: pkg.origin,
    appliedCount,
    conflictCount: plan.newConflicts.length,
    skipped: false,
  };
}

/* ------------------------------ 冲突决议 ------------------------------ */

export type ConflictResolution = 'local' | 'remote';

export interface ConflictGroup {
  groupId: string;
  rows: SyncConflict[];
}

/** 未决冲突按级联组聚合（同组一次性决议，避免删了上级留下孤立子记录） */
export function groupConflicts(conflicts: SyncConflict[]): ConflictGroup[] {
  const map = new Map<string, SyncConflict[]>();
  conflicts.forEach((row) => {
    map.set(row.groupId, [...(map.get(row.groupId) ?? []), row]);
  });
  return Array.from(map.entries())
    .map(([groupId, rows]) => ({
      groupId,
      rows: [...rows].sort((a, b) => a.entity.localeCompare(b.entity) || a.recordId.localeCompare(b.recordId)),
    }))
    .sort((a, b) => b.rows[0]?.createdAt - a.rows[0]?.createdAt);
}

/**
 * 写入一组冲突的选择结果：
 * - 选「本机工作库」：组内本机有值的记录按本机值写回并对齐基准，本机无值（纯新增被拦）的保持本机现状；
 *   属于被删子树的记录保持存活，同时压制（不采纳）协作包墓碑。
 * - 选「协作包」：组内协作包有值的记录按协作包值写入，协作包无值（删除）的沿关系删除并补墓碑；
 *   组内所有冲突行随后清除。单事务提交，失败恢复决议前状态。
 */
export async function resolveConflictGroup(group: ConflictGroup, choice: ConflictResolution): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.tombstones, db.conflicts],
    async () => {
      for (const conflict of group.rows) {
        const { entity } = conflict;
        const chosen = choice === 'local' ? conflict.localValue : conflict.remoteValue;
        const other = choice === 'local' ? conflict.remoteValue : conflict.localValue;
        const putRow = async (row: AnyBusinessRecord): Promise<void> => {
          switch (entity) {
            case 'steles':
              await db.steles.put(row as Stele);
              break;
            case 'rubbings':
              await db.rubbings.put(row as Rubbing);
              break;
            case 'losses':
              await db.losses.put(row as Loss);
              break;
            case 'seals':
              await db.seals.put(row as Seal);
              break;
            case 'compares':
              await db.compares.put(row as Compare);
              break;
          }
        };
        const getRow = async (): Promise<AnyBusinessRecord | undefined> => {
          switch (entity) {
            case 'steles':
              return db.steles.get(conflict.recordId);
            case 'rubbings':
              return db.rubbings.get(conflict.recordId);
            case 'losses':
              return db.losses.get(conflict.recordId);
            case 'seals':
              return db.seals.get(conflict.recordId);
            case 'compares':
              return db.compares.get(conflict.recordId);
          }
        };
        const deleteRow = async (): Promise<void> => {
          switch (entity) {
            case 'steles':
              await db.steles.delete(conflict.recordId);
              break;
            case 'rubbings':
              await db.rubbings.delete(conflict.recordId);
              break;
            case 'losses':
              await db.losses.delete(conflict.recordId);
              break;
            case 'seals':
              await db.seals.delete(conflict.recordId);
              break;
            case 'compares':
              await db.compares.delete(conflict.recordId);
              break;
          }
        };
        if (chosen) {
          // 以选中值为准，双方在冲突时刻的版本都成为历史：版本对齐到高者、基准抬平
          const version = Math.max(
            conflict.localValue?.version ?? chosen.version,
            conflict.remoteValue?.version ?? chosen.version,
          );
          await putRow({ ...chosen, version, baseVersion: version });
          // 任一侧曾删除而本次选择保留活记录：对应墓碑必须撤下，否则会再次传播旧删除事实
          if (!other || conflict.kind === 'local-delete-remote-edit' || conflict.kind === 'remote-delete-local-edit') {
            await db.tombstones.delete(conflict.id);
          }
        } else {
          // 选中侧没有值（选协作包删除，或本机侧本就为空的极端情况）
          if (choice === 'remote') {
            const existing = await getRow();
            if (existing) {
              await db.tombstones.put({
                id: conflict.id,
                entity,
                recordId: conflict.recordId,
                version: existing.version,
                origin: getOrigin(),
                deletedAt: Date.now(),
              });
            }
            await deleteRow();
          }
        }
      }
      await db.conflicts.bulkDelete(group.rows.map((row) => row.id));
    },
  );
}
