/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录）
 * - 五张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import type { AppliedPackage, SyncCollections, SyncConflict, SyncRecord, SyncTable } from '@/types/sync';
import { sortLosses } from './collate';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbrubbing';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** 共同基准快照在 syncBaseline 表中的固定主键 */
export const BASELINE_DOC_ID = 'current';

/** 初始共同基准版本号（历史升级时统一补为该值） */
export const INITIAL_BASE_VERSION = 1;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbrubbing:db-version',
  lastBackupAt: 'gbrubbing:last-backup-at',
  uiPrefs: 'gbrubbing:ui-prefs',
} as const;

export interface UiPrefs {
  lastSteleId: string | null;
  lastRubbingId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastSteleId: null, lastRubbingId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      lastSteleId: typeof parsed.lastSteleId === 'string' ? parsed.lastSteleId : null,
      lastRubbingId: typeof parsed.lastRubbingId === 'string' ? parsed.lastRubbingId : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

/** syncBaseline 表中单条基准文档：五张表最近一次共同基准的完整快照 */
export interface BaselineDoc {
  id: string;
  updatedAt: number;
  collections: SyncCollections;
}

/** 全部需要在导入 / 清空 / 对账中一起处理的 Dexie 表名 */
export const ALL_DB_TABLES = ['steles', 'rubbings', 'losses', 'seals', 'compares', 'syncConflicts', 'appliedPackages'] as const;

class RubbingDatabase extends Dexie {
  steles!: Table<Stele, string>;
  rubbings!: Table<Rubbing, string>;
  losses!: Table<Loss, string>;
  seals!: Table<Seal, string>;
  compares!: Table<Compare, string>;
  /** 未决协作冲突（两边都改过的记录，保留双方取值待人工选定） */
  syncConflicts!: Table<SyncConflict, string>;
  /** 已合入协作包登记（幂等去重） */
  appliedPackages!: Table<AppliedPackage, string>;
  /** 共同基准快照（单行文档） */
  syncBaseline!: Table<BaselineDoc, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史字位记录仅有 lineNo）
    this.version(1).stores({
      steles: 'id, title, era, form, updatedAt',
      rubbings: 'id, steleId, versionNo, method, state, updatedAt',
      losses: 'id, rubbingId, lineNo, type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, updatedAt',
    });

    // v2：Loss 增加 charNo 与 [rubbingId+lineNo+charNo] 复合索引，并按行号顺序重建历史字位记录
    this.version(2).stores({
      steles: 'id, title, era, form, location, updatedAt',
      rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
      losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, position, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
    });

    // v3：协作对账 —— 五张业务表补 baseVersion（共同基准版本），
    // 新增 syncConflicts（未决冲突区）、appliedPackages（已合入包登记）、syncBaseline（共同基准快照）。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        steles: 'id, title, era, form, location, baseVersion, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, baseVersion, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, baseVersion, updatedAt',
        seals: 'id, rubbingId, sealType, position, baseVersion, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, baseVersion, updatedAt',
        syncConflicts: 'id, packageId, table, recordId, steleId, updatedAt',
        appliedPackages: 'id, appliedAt',
        syncBaseline: 'id',
      })
      .upgrade(async (tx) => {
        // 先承接 v2 升级逻辑：为历史字位记录重建 charNo
        const lossTable = tx.table<Loss>('losses');
        const legacyLosses = await lossTable.toArray();
        const byRubbing = new Map<string, Loss[]>();
        legacyLosses.forEach((loss) => {
          byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
        });
        const rebuilt: Loss[] = [];
        byRubbing.forEach((list) => {
          // 按行号排序后，为缺失 charNo 的历史记录在行内顺序补位
          const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
          const counter = new Map<number, number>();
          sorted.forEach((loss) => {
            const used = counter.get(loss.lineNo) ?? 0;
            const charNo = typeof loss.charNo === 'number' && loss.charNo > 0 ? loss.charNo : used + 1;
            counter.set(loss.lineNo, Math.max(used, charNo));
            rebuilt.push({ ...loss, charNo });
          });
        });

        // 为全部历史业务记录补上初始共同基准版本（已有比对记录等历史数据就地保留、仍可查看）
        const stamp = <T extends object>(rows: T[]): T[] =>
          rows.map((row) => ({ ...row, baseVersion: INITIAL_BASE_VERSION }));
        const steles = stamp(await tx.table<Stele>('steles').toArray());
        const rubbings = stamp(await tx.table<Rubbing>('rubbings').toArray());
        const losses = stamp(sortLosses(rebuilt));
        const seals = stamp(await tx.table<Seal>('seals').toArray());
        const compares = stamp(await tx.table<Compare>('compares').toArray());

        await tx.table<Stele>('steles').bulkPut(steles);
        await tx.table<Rubbing>('rubbings').bulkPut(rubbings);
        await lossTable.bulkPut(losses);
        await tx.table<Seal>('seals').bulkPut(seals);
        await tx.table<Compare>('compares').bulkPut(compares);

        // 把当前整库快照固化为初始共同基准
        const baselineTable = tx.table<BaselineDoc>('syncBaseline');
        const collections: SyncCollections = { steles, rubbings, losses, seals, compares };
        await baselineTable.put({ id: BASELINE_DOC_ID, updatedAt: Date.now(), collections });
      });
  }
}

export const db = new RubbingDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.steles.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stele → Rubbing →（Loss / Seal）＋ Stele → Compare */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const steles: Array<Omit<Stele, "baseVersion">> = [
    {
      id: 'stele_01',
      title: '礼器碑',
      era: '东汉永寿二年',
      location: '山东曲阜孔庙',
      form: 'stele',
      sizeCm: '227×93',
      calligrapher: '佚名（隶书）',
      createdAt: now - day * 60,
      updatedAt: now - day * 3,
    },
    {
      id: 'stele_02',
      title: '石门颂',
      era: '东汉建和二年',
      location: '陕西汉中石门',
      form: 'cliff',
      sizeCm: '261×205',
      calligrapher: '王升（隶书）',
      createdAt: now - day * 48,
      updatedAt: now - day * 2,
    },
    {
      id: 'stele_03',
      title: '颜勤礼碑',
      era: '唐大历十四年',
      location: '陕西西安碑林',
      form: 'stele',
      sizeCm: '268×92',
      calligrapher: '颜真卿（楷书）',
      createdAt: now - day * 36,
      updatedAt: now - day,
    },
  ];

  const rubbings: Array<Omit<Rubbing, "baseVersion">> = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: 'TB-0301', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
  ];

  const losses: Array<Omit<Loss, "baseVersion">> = [
    { id: 'loss_010101', rubbingId: 'rub_0101', lineNo: 3, charNo: 7, type: 'blur', severity: 'light', note: '「壽」字右下漫漶', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'loss_010102', rubbingId: 'rub_0101', lineNo: 5, charNo: 2, type: 'stoneFlower', severity: 'medium', note: '石花漫及「年」字', createdAt: now - day * 30, updatedAt: now - day * 29 },
    { id: 'loss_010103', rubbingId: 'rub_0101', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字缺末笔', createdAt: now - day * 28, updatedAt: now - day * 28 },
    { id: 'loss_010201', rubbingId: 'rub_0102', lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', note: '晚拓，「壽」字已损', createdAt: now - day * 24, updatedAt: now - day * 24 },
    { id: 'loss_010202', rubbingId: 'rub_0102', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字全缺', createdAt: now - day * 24, updatedAt: now - day * 22 },
    { id: 'loss_010203', rubbingId: 'rub_0102', lineNo: 12, charNo: 4, type: 'crack', severity: 'medium', note: '碑面斜裂一道', createdAt: now - day * 22, updatedAt: now - day * 22 },
    { id: 'loss_020101', rubbingId: 'rub_0201', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_020201', rubbingId: 'rub_0202', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂（同前）', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'loss_020202', rubbingId: 'rub_0202', lineNo: 6, charNo: 3, type: 'blur', severity: 'medium', note: '晚拓，「頌」字已漫漶', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_030101', rubbingId: 'rub_0301', lineNo: 4, charNo: 3, type: 'blur', severity: 'heavy', note: '民国拓，字口已平', createdAt: now - day * 10, updatedAt: now - day * 10 },
  ];

  const seals: Array<Omit<Seal, "baseVersion">> = [
    { id: 'seal_0101', rubbingId: 'rub_0101', sealText: '端方藏碑', position: '右下角', transcription: '端方（匋斋）收藏印', sealType: 'collection', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0102', rubbingId: 'rub_0101', sealText: '匋斋鉴赏', position: '左下角', transcription: '端方鉴赏印', sealType: 'appraisal', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0103', rubbingId: 'rub_0102', sealText: '艺风堂', position: '卷尾', transcription: '缪荃孙艺风堂藏书印', sealType: 'collection', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'seal_0201', rubbingId: 'rub_0201', sealText: '石门旧拓', position: '左上角', transcription: '藏家自钤印', sealType: 'author', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const compares: Array<Omit<Compare, "baseVersion">> = [
    { id: 'cmp_0101', steleId: 'stele_01', rubbingIdA: 'rub_0101', rubbingIdB: 'rub_0102', diffCount: 3, conclusion: 'early', operator: '傅砚', date: '2026-03-06', createdAt: now - day * 5, updatedAt: now - day * 5 },
    { id: 'cmp_0201', steleId: 'stele_02', rubbingIdA: 'rub_0201', rubbingIdB: 'rub_0202', diffCount: 1, conclusion: 'late', operator: '傅砚', date: '2026-03-08', createdAt: now - day * 3, updatedAt: now - day * 3 },
  ];

  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.syncBaseline], async () => {
    const withBase = <T extends object>(rows: Array<Omit<T, 'baseVersion'>>): T[] =>
      rows.map((row) => ({ ...row, baseVersion: INITIAL_BASE_VERSION }) as T);
    const seeded: BusinessCollections = {
      steles: withBase<Stele>(steles),
      rubbings: withBase<Rubbing>(rubbings),
      losses: withBase<Loss>(losses),
      seals: withBase<Seal>(seals),
      compares: withBase<Compare>(compares),
    };
    await db.steles.bulkPut(seeded.steles);
    await db.rubbings.bulkPut(seeded.rubbings);
    await db.losses.bulkPut(seeded.losses);
    await db.seals.bulkPut(seeded.seals);
    await db.compares.bulkPut(seeded.compares);
    // 播种数据的初始共同基准即其自身
    await db.syncBaseline.put({ id: BASELINE_DOC_ID, updatedAt: Date.now(), collections: seeded as SyncCollections });
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RubbingSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
  /** 协作对账共同基准快照（旧备份可能没有，导入时按当前数据补建） */
  syncBaseline?: BaselineDoc | null;
  /** 未决冲突与已合入包登记（随整库备份带走，换设备不丢） */
  syncConflicts?: SyncConflict[];
  appliedPackages?: AppliedPackage[];
}

/** 为缺失 baseVersion 的历史记录补初始基准版本（兼容 v2 及更早的备份文件） */
function ensureBaseVersion<T>(rows: T[]): T[] {
  return rows.map((row) =>
    typeof (row as Partial<{ baseVersion: unknown }>).baseVersion === 'number'
      ? row
      : { ...row, baseVersion: INITIAL_BASE_VERSION },
  );
}

/** 五张业务表的具体集合 */
export interface BusinessCollections {
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
}

/** 读取五张业务表当前数据 */
export async function readBusinessCollections(): Promise<BusinessCollections> {
  const [steles, rubbings, losses, seals, compares] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
  ]);
  return { steles, rubbings, losses, seals, compares };
}

/** 读取共同基准快照；不存在或为空库时以当前数据初始化为初始基准 */
export async function ensureBaseline(): Promise<BaselineDoc> {
  const existing = await db.syncBaseline.get(BASELINE_DOC_ID);
  if (existing) return existing;
  const collections = (await readBusinessCollections()) as SyncCollections;
  const doc: BaselineDoc = { id: BASELINE_DOC_ID, updatedAt: Date.now(), collections };
  await db.syncBaseline.put(doc);
  return doc;
}

export async function readBaseline(): Promise<BaselineDoc | null> {
  return (await db.syncBaseline.get(BASELINE_DOC_ID)) ?? null;
}

/** 覆盖写入共同基准快照 */
export async function writeBaseline(collections: SyncCollections, updatedAt = Date.now()): Promise<void> {
  await db.syncBaseline.put({ id: BASELINE_DOC_ID, updatedAt, collections });
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const collections = await readBusinessCollections();
  const [baseline, conflicts, applied] = await Promise.all([
    readBaseline(),
    db.syncConflicts.toArray(),
    db.appliedPackages.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    ...collections,
    syncBaseline: baseline ?? null,
    syncConflicts: conflicts,
    appliedPackages: applied,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.syncConflicts, db.appliedPackages, db.syncBaseline],
    async () => {
      await Promise.all([
        db.steles.clear(),
        db.rubbings.clear(),
        db.losses.clear(),
        db.seals.clear(),
        db.compares.clear(),
        db.syncConflicts.clear(),
        db.appliedPackages.clear(),
        db.syncBaseline.clear(),
      ]);
    },
  );
}

/**
 * 整库覆盖导入（JSON 备份）。
 * 写入前补齐历史记录的初始基准版本；备份未带基准快照时以导入内容建立初始基准，
 * 使旧备份导入后仍可继续协作对账。整段在事务内完成，失败自动回到导入前状态。
 */
export async function importSnapshot(snapshot: RubbingSnapshot): Promise<void> {
  const steles = ensureBaseVersion(snapshot.steles);
  const rubbings = ensureBaseVersion(snapshot.rubbings);
  const losses = ensureBaseVersion(snapshot.losses);
  const seals = ensureBaseVersion(snapshot.seals);
  const compares = ensureBaseVersion(snapshot.compares);
  const collections: SyncCollections = { steles, rubbings, losses, seals, compares };
  const baseline: BaselineDoc =
    snapshot.syncBaseline ?? { id: BASELINE_DOC_ID, updatedAt: Date.now(), collections };

  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.syncConflicts, db.appliedPackages, db.syncBaseline],
    async () => {
      await Promise.all([
        db.steles.clear(),
        db.rubbings.clear(),
        db.losses.clear(),
        db.seals.clear(),
        db.compares.clear(),
        db.syncConflicts.clear(),
        db.appliedPackages.clear(),
        db.syncBaseline.clear(),
      ]);
      await db.steles.bulkPut(steles);
      await db.rubbings.bulkPut(rubbings);
      await db.losses.bulkPut(losses);
      await db.seals.bulkPut(seals);
      await db.compares.bulkPut(compares);
      await db.syncBaseline.put(baseline);
      if (snapshot.syncConflicts && snapshot.syncConflicts.length > 0) {
        await db.syncConflicts.bulkPut(snapshot.syncConflicts);
      }
      if (snapshot.appliedPackages && snapshot.appliedPackages.length > 0) {
        await db.appliedPackages.bulkPut(snapshot.appliedPackages);
      }
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares] = await Promise.all([
    db.steles.count(),
    db.rubbings.count(),
    db.losses.count(),
    db.seals.count(),
    db.compares.count(),
  ]);
  return { steles, rubbings, losses, seals, compares };
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 比对，并清理相关未决冲突 */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.syncConflicts],
    async () => {
      const childIds = new Set<string>();
      if (rubbingIds.length > 0) {
        const lossIds = (await db.losses.where('rubbingId').anyOf(rubbingIds).toArray()).map((row) => row.id);
        const sealIds = (await db.seals.where('rubbingId').anyOf(rubbingIds).toArray()).map((row) => row.id);
        lossIds.forEach((id) => childIds.add(id));
        sealIds.forEach((id) => childIds.add(id));
        await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
        await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
      }
      const compareIds = (await db.compares.where('steleId').equals(steleId).toArray()).map((row) => row.id);
      compareIds.forEach((id) => childIds.add(id));
      await db.rubbings.where('steleId').equals(steleId).delete();
      await db.compares.where('steleId').equals(steleId).delete();
      await db.steles.delete(steleId);
      // 冲突区内引用这些已删除记录的未决条目一并清理
      const conflictIds = (await db.syncConflicts.toArray())
        .filter((row) => row.steleId === steleId || childIds.has(row.recordId) || row.recordId === steleId)
        .map((row) => row.id);
      if (conflictIds.length > 0) await db.syncConflicts.bulkDelete(conflictIds);
    },
  );
}

/** 级联删除拓本 → 损泐 / 钤印 / 涉及的比对记录，并清理相关未决冲突 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.rubbings, db.losses, db.seals, db.compares, db.syncConflicts],
    async () => {
      const childIds = new Set<string>();
      (await db.losses.where('rubbingId').equals(rubbingId).toArray()).forEach((row) => childIds.add(row.id));
      (await db.seals.where('rubbingId').equals(rubbingId).toArray()).forEach((row) => childIds.add(row.id));
      await db.losses.where('rubbingId').equals(rubbingId).delete();
      await db.seals.where('rubbingId').equals(rubbingId).delete();
      const compares = await db.compares.toArray();
      const affected = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
      affected.forEach((row) => childIds.add(row.id));
      if (affected.length > 0) await db.compares.bulkDelete(affected.map((row) => row.id));
      await db.rubbings.delete(rubbingId);
      // 冲突区内引用该拓本及其已删子记录的未决条目一并清理
      const conflictIds = (await db.syncConflicts.toArray())
        .filter((row) => childIds.has(row.recordId) || row.recordId === rubbingId)
        .map((row) => row.id);
      if (conflictIds.length > 0) await db.syncConflicts.bulkDelete(conflictIds);
    },
  );
}

/** 重排某碑刻下拓本的版本序号，保证连续（不改变共同基准版本） */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  await db.rubbings.bulkPut(sorted.map((row, index) => ({ ...row, versionNo: index + 1 })));
}

/** 冲突区 / 已合入包查询，供协作页使用 */
export async function listSyncConflicts(): Promise<SyncConflict[]> {
  const rows = await db.syncConflicts.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listAppliedPackages(): Promise<AppliedPackage[]> {
  const rows = await db.appliedPackages.toArray();
  return rows.sort((a, b) => b.appliedAt - a.appliedAt);
}

/** 共同基准版本号工具：本地写入新版本时在旧值上 +1（历史缺省记录视为初始版本） */
export function bumpBaseVersion(previous: number | undefined): number {
  return typeof previous === 'number' && previous >= 1 ? previous + 1 : INITIAL_BASE_VERSION + 1;
}

export type { SyncRecord, SyncTable };
