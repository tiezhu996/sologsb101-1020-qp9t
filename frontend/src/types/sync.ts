/**
 * 离线协作（协作包对账）类型
 * - 业务记录统一带 version（当前版本）/ baseVersion（共同基准版本）
 * - 删除沿业务关系传播：删除碑刻 / 拓本时写墓碑（Tombstone）
 * - 同一记录两边都改过 → SyncConflict 冲突区，未决前继续保留
 */
import type { Stele } from './stele';
import type { Rubbing } from './rubbing';
import type { Loss } from './loss';
import type { Seal } from './seal';
import type { Compare } from './compare';

/** 五张业务表标识，用于墓碑与冲突定位 */
export type SyncEntityName = 'steles' | 'rubbings' | 'losses' | 'seals' | 'compares';

export const SYNC_ENTITY_LABEL: Record<SyncEntityName, string> = {
  steles: '碑刻',
  rubbings: '拓本',
  losses: '损泐字位',
  seals: '钤印',
  compares: '比对记录',
};

/** 带协作版本信息的业务记录 */
export interface VersionedRecord {
  /** 当前版本：新建为 1，本机每改一次 +1；导入对账时由合并结果决定 */
  version: number;
  /** 共同基准版本：最后一次与协作方对齐时该记录的版本 */
  baseVersion: number;
}

export type AnyBusinessRecord = Stele | Rubbing | Loss | Seal | Compare;

/** 删除墓碑：记录被删除时落库，随协作包传播删除事实 */
export interface Tombstone {
  /** 主键 `${entity}:${recordId}`，业务 id 在五张表间互不重叠 */
  id: string;
  entity: SyncEntityName;
  recordId: string;
  /** 删除时该记录的版本，用于删除与修改的三方对账 */
  version: number;
  /** 来源机器（库标识） */
  origin: string;
  deletedAt: number;
}

/** 协作包：两侧记录对账的完整载荷（含墓碑，去重靠 packageId 登记） */
export interface SyncPackage {
  app: 'gbrubbing';
  kind: 'collab';
  /** 协作包唯一编号，重复导入同一包不重复新增 */
  packageId: string;
  /** 导出方库标识 */
  origin: string;
  exportedAt: string;
  schemaVersion: number;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
  tombstones: Tombstone[];
}

export const SYNC_COLLECTIONS: ReadonlyArray<SyncEntityName> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];

/** 冲突性质：两边改同一条 / 一边删一边改 / 一边删一边新增关联记录 */
export type SyncConflictKind = 'modify-modify' | 'remote-delete-local-edit' | 'local-delete-remote-edit' | 'remote-delete-local-create';

/**
 * 未决冲突：同一业务记录两边都改过（或删改相抵）时进入冲突区。
 * 拓本 / 碑刻删除沿业务关系级联，相关行用 groupId 绑成一组决议。
 */
export interface SyncConflict {
  /** 冲突主键 `${entity}:${recordId}`，同记录重复导入只更新一条 */
  id: string;
  /** 删除级联组：同一次「删碑刻 / 删拓本」拦下的记录共用一个组 id，按组整体决议 */
  groupId: string;
  entity: SyncEntityName;
  recordId: string;
  kind: SyncConflictKind;
  /** 冲突发生时本机工作库的记录（本机删除则为 null） */
  localValue: AnyBusinessRecord | null;
  /** 冲突发生时协作包中的记录（协作包删除则为 null） */
  remoteValue: AnyBusinessRecord | null;
  /** 来源协作包 */
  packageId: string;
  origin: string;
  createdAt: number;
}

/** 已导入协作包登记：重复导入同一包直接拒绝，保证幂等 */
export interface PackageLedgerEntry {
  packageId: string;
  origin: string;
  importedAt: string;
  appliedCount: number;
  conflictCount: number;
}

/** 冲突主键（同记录跨包只保留最早一条未决冲突） */
export function conflictKey(entity: SyncEntityName, recordId: string): string {
  return `${entity}:${recordId}`;
}

/** 墓碑主键 */
export function tombstoneKey(entity: SyncEntityName, recordId: string): string {
  return `${entity}:${recordId}`;
}

export const SYNC_CONFLICT_KIND_LABEL: Record<SyncConflictKind, string> = {
  'modify-modify': '两边都改过',
  'remote-delete-local-edit': '协作包已删除 · 本机改过',
  'local-delete-remote-edit': '本机已删除 · 协作包改过',
  'remote-delete-local-create': '协作包已删除上级 · 本机新增关联记录',
};
