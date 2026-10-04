/**
 * 协作对账（Sync）类型
 * 馆员离线补录后交换协作包，按「共同基准 / 本机工作库 / 协作包」三方对账；
 * 同一记录两边都改过则进入冲突区，保留双方取值直至人工选定。
 */
import type { Stele } from './stele';
import type { Rubbing } from './rubbing';
import type { Loss } from './loss';
import type { Seal } from './seal';
import type { Compare } from './compare';

/** 参与协作对账的五张业务表名 */
export type SyncTable = 'steles' | 'rubbings' | 'losses' | 'seals' | 'compares';

export const SYNC_TABLES: readonly SyncTable[] = ['steles', 'rubbings', 'losses', 'seals', 'compares'] as const;

/** 任一业务记录（都携带共同基准版本号 baseVersion） */
export type SyncRecord = Stele | Rubbing | Loss | Seal | Compare;

export type SyncCollections = Record<SyncTable, SyncRecord[]>;

/** 冲突形态：两边都改了 / 一边改一边删 / 两边独立新建同 id */
export type SyncConflictKind = 'modify-modify' | 'modify-delete' | 'create-create';

/** 未决冲突：同时保存本机工作库与协作包两侧的值，选定后再写入 */
export interface SyncConflict {
  id: string;
  /** 协作包 id（同一包重复导入据此识别，幂等去重） */
  packageId: string;
  table: SyncTable;
  /** 业务记录 id */
  recordId: string;
  kind: SyncConflictKind;
  /** 冲突产生时的共同基准记录（可能为空：两边独立新建） */
  base: SyncRecord | null;
  /** 本机工作库的值（本机已删除时为 null） */
  local: SyncRecord | null;
  /** 协作包的值（对侧已删除时为 null） */
  incoming: SyncRecord | null;
  /** 解析时锚定的碑刻 id（便于按碑分组展示） */
  steleId: string | null;
  /** 记录摘要（碑名 / 拓本 / 坐标等），冲突列表直接展示 */
  label: string;
  createdAt: number;
  updatedAt: number;
}

/** 已成功合入的协作包登记（重复导入同一包不重复新增） */
export interface AppliedPackage {
  /** 协作包 id */
  id: string;
  producer: string;
  appliedAt: number;
  /** 包导出时间 */
  exportedAt: string;
}

/** 对账后的单边变化，导入时自动应用 */
export interface SyncChange {
  table: SyncTable;
  recordId: string;
  /** upsert：单边新增 / 单边修改；delete：单边删除 */
  action: 'upsert' | 'delete';
  record: SyncRecord | null;
  /** 应用后建议的基准版本（以包侧版本为准） */
  nextBaseVersion: number;
  steleId: string | null;
  label: string;
}

/** 对账结果：单边变化直接应用，冲突进入冲突区 */
export interface MergePlan {
  packageId: string;
  producer: string;
  exportedAt: string;
  baseAt: string;
  changes: SyncChange[];
  conflicts: SyncConflict[];
  /** 对账时各表记录数，供预览展示 */
  counts: Record<SyncTable, { local: number; incoming: number; base: number }>;
}

export const SYNC_CONFLICT_KIND_LABEL: Record<SyncConflictKind, string> = {
  'modify-modify': '两边都改过',
  'modify-delete': '一边改一边删',
  'create-create': '两边各自新建',
};
