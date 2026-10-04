/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录
 *   v2 → v3：业务记录增加 version / baseVersion 协作版本字段（历史数据补初始基准 v1），
 *            新增 tombstones（删除墓碑）/ conflicts（未决冲突）/ packageLedger（已导入协作包）
 * - 五张业务表 + 三张协作表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import type {
  AnyBusinessRecord,
  PackageLedgerEntry,
  SyncConflict,
  SyncEntityName,
  Tombstone,
  VersionedRecord,
} from '@/types/sync';
import { tombstoneKey } from '@/types/sync';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbrubbing';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** 记录的初始版本：新建与历史升级均从 v1 起 */
export const INITIAL_RECORD_VERSION = 1;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbrubbing:db-version',
  lastBackupAt: 'gbrubbing:last-backup-at',
  uiPrefs: 'gbrubbing:ui-prefs',
  /** 本机库标识，随协作包 / 墓碑写出，用于标注来源 */
  origin: 'gbrubbing:origin',
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

/** 本机库标识：首次取用即生成并记住，协作包、墓碑与冲突据此标来源 */
export function getOrigin(): string {
  try {
    const existed = localStorage.getItem(LS_KEYS.origin);
    if (existed) return existed;
    const rand = Math.random().toString(36).slice(2, 10);
    const origin = `station-${Date.now().toString(36)}${rand}`;
    localStorage.setItem(LS_KEYS.origin, origin);
    return origin;
  } catch {
    return 'station-unknown';
  }
}

/** 给业务记录盖初始版本（新建用） */
export function withInitialVersion<T extends object>(row: T): T & VersionedRecord {
  return { ...row, version: INITIAL_RECORD_VERSION, baseVersion: INITIAL_RECORD_VERSION };
}

/** 本机修改：当前版本 +1，共同基准保持不变 */
export function bumpVersion<T extends VersionedRecord>(row: T): T {
  return { ...row, version: row.version + 1 };
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

class RubbingDatabase extends Dexie {
  steles!: Table<Stele, string>;
  rubbings!: Table<Rubbing, string>;
  losses!: Table<Loss, string>;
  seals!: Table<Seal, string>;
  compares!: Table<Compare, string>;
  tombstones!: Table<Tombstone, string>;
  conflicts!: Table<SyncConflict, string>;
  packageLedger!: Table<PackageLedgerEntry, string>;

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
    this.version(2)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table<Loss>('losses');
        const all = await table.toArray();
        const byRubbing = new Map<string, Loss[]>();
        all.forEach((loss) => {
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
            rebuilt.push({ ...loss, charNo, updatedAt: Date.now() });
          });
        });
        await table.bulkPut(rebuilt);
      });

    // v3：业务记录增加协作版本字段（历史数据补初始基准 v1，已有比对记录原样保留可查看），
    // 新增 tombstones / conflicts / packageLedger 三张协作表。
    // 注：由 v1 直升 v3 时 Dexie 会先执行 v2 的 upgrade() 重建 charNo，这里只补版本字段。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
        tombstones: 'id, entity, recordId, deletedAt',
        conflicts: 'id, groupId, entity, recordId, packageId, createdAt',
        packageLedger: 'packageId, origin, importedAt',
      })
      .upgrade(async (tx) => {
        // 为全部历史业务记录补上初始基准版本 v1（已有比对记录内容原样保留）
        const entityNames: SyncEntityName[] = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
        for (const name of entityNames) {
          const table = tx.table<AnyBusinessRecord & VersionedRecord, string>(name);
          const rows = await table.toArray();
          const stamped = rows
            .filter((row) => typeof row.version !== 'number' || typeof row.baseVersion !== 'number')
            .map((row) => ({
              ...row,
              version: typeof row.version === 'number' && row.version > 0 ? row.version : INITIAL_RECORD_VERSION,
              baseVersion:
                typeof row.baseVersion === 'number' && row.baseVersion > 0
                  ? row.baseVersion
                  : INITIAL_RECORD_VERSION,
            }));
          if (stamped.length > 0) await table.bulkPut(stamped);
        }
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

  const steles: Array<Omit<Stele, 'version' | 'baseVersion'>> = [
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

  const rubbings: Array<Omit<Rubbing, 'version' | 'baseVersion'>> = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: 'TB-0301', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
  ];

  const losses: Array<Omit<Loss, 'version' | 'baseVersion'>> = [
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

  const seals: Array<Omit<Seal, 'version' | 'baseVersion'>> = [
    { id: 'seal_0101', rubbingId: 'rub_0101', sealText: '端方藏碑', position: '右下角', transcription: '端方（匋斋）收藏印', sealType: 'collection', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0102', rubbingId: 'rub_0101', sealText: '匋斋鉴赏', position: '左下角', transcription: '端方鉴赏印', sealType: 'appraisal', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0103', rubbingId: 'rub_0102', sealText: '艺风堂', position: '卷尾', transcription: '缪荃孙艺风堂藏书印', sealType: 'collection', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'seal_0201', rubbingId: 'rub_0201', sealText: '石门旧拓', position: '左上角', transcription: '藏家自钤印', sealType: 'author', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const compares: Array<Omit<Compare, 'version' | 'baseVersion'>> = [
    { id: 'cmp_0101', steleId: 'stele_01', rubbingIdA: 'rub_0101', rubbingIdB: 'rub_0102', diffCount: 3, conclusion: 'early', operator: '傅砚', date: '2026-03-06', createdAt: now - day * 5, updatedAt: now - day * 5 },
    { id: 'cmp_0201', steleId: 'stele_02', rubbingIdA: 'rub_0201', rubbingIdB: 'rub_0202', diffCount: 1, conclusion: 'late', operator: '傅砚', date: '2026-03-08', createdAt: now - day * 3, updatedAt: now - day * 3 },
  ];

  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.tombstones, db.conflicts, db.packageLedger],
    async () => {
      await db.steles.bulkPut(steles.map(withInitialVersion));
      await db.rubbings.bulkPut(rubbings.map(withInitialVersion));
      await db.losses.bulkPut(losses.map(withInitialVersion));
      await db.seals.bulkPut(seals.map(withInitialVersion));
      await db.compares.bulkPut(compares.map(withInitialVersion));
    },
  );
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
  /** 协作数据随整库备份带走；旧版备份没有这三列，导入时按空处理 */
  tombstones?: Tombstone[];
  conflicts?: SyncConflict[];
  packageLedger?: PackageLedgerEntry[];
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const [steles, rubbings, losses, seals, compares, tombstones, conflicts, packageLedger] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
    db.tombstones.toArray(),
    db.conflicts.toArray(),
    db.packageLedger.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    steles,
    rubbings,
    losses,
    seals,
    compares,
    tombstones,
    conflicts,
    packageLedger,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot> & { kind?: string };
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  if (snapshot.kind === 'collab') return '该文件是协作包，请使用「协作包合并」入口导入，不能作整库备份覆盖。';
  const keys: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

/** 旧版备份（v2 之前）的记录没有协作版本字段，补盖初始基准后再写库 */
function ensureVersioned<T extends object>(rows: T[]): Array<T & VersionedRecord> {
  return rows.map((row) => {
    const candidate = row as Partial<VersionedRecord>;
    if (
      typeof candidate.version === 'number' &&
      candidate.version > 0 &&
      typeof candidate.baseVersion === 'number' &&
      candidate.baseVersion > 0
    ) {
      return row as T & VersionedRecord;
    }
    return withInitialVersion(row);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.tombstones, db.conflicts, db.packageLedger],
    async () => {
      await Promise.all([
        db.steles.clear(),
        db.rubbings.clear(),
        db.losses.clear(),
        db.seals.clear(),
        db.compares.clear(),
        db.tombstones.clear(),
        db.conflicts.clear(),
        db.packageLedger.clear(),
      ]);
    },
  );
}

export async function importSnapshot(snapshot: RubbingSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.tombstones, db.conflicts, db.packageLedger],
    async () => {
      await db.steles.bulkPut(ensureVersioned(snapshot.steles));
      await db.rubbings.bulkPut(ensureVersioned(snapshot.rubbings));
      await db.losses.bulkPut(ensureVersioned(snapshot.losses));
      await db.seals.bulkPut(ensureVersioned(snapshot.seals));
      await db.compares.bulkPut(ensureVersioned(snapshot.compares));
      if (snapshot.tombstones) await db.tombstones.bulkPut(snapshot.tombstones);
      if (snapshot.conflicts) await db.conflicts.bulkPut(snapshot.conflicts);
      if (snapshot.packageLedger) await db.packageLedger.bulkPut(snapshot.packageLedger);
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

/* ------------------------------ 墓碑（删除沿业务关系传播） ------------------------------ */

function makeTombstone(entity: SyncEntityName, record: AnyBusinessRecord): Tombstone {
  return {
    id: tombstoneKey(entity, record.id),
    entity,
    recordId: record.id,
    version: record.version,
    origin: getOrigin(),
    deletedAt: Date.now(),
  };
}

/** 叶子记录（损泐 / 钤印 / 比对）单条删除：先写墓碑，供协作包对账时传播删除事实 */
export async function removeRecordWithTombstone(entity: 'losses' | 'seals' | 'compares', id: string): Promise<void> {
  const table: Table<AnyBusinessRecord, string> =
    entity === 'losses'
      ? (db.losses as unknown as Table<AnyBusinessRecord, string>)
      : entity === 'seals'
        ? (db.seals as unknown as Table<AnyBusinessRecord, string>)
        : (db.compares as unknown as Table<AnyBusinessRecord, string>);
  await db.transaction('rw', [table, db.tombstones], async () => {
    const record = await table.get(id);
    if (record) await db.tombstones.put(makeTombstone(entity, record));
    await table.delete(id);
  });
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 比对；每一层都写墓碑，删除事实沿关系传播 */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const stele = await db.steles.get(steleId);
  const rubbings = await db.rubbings.where('steleId').equals(steleId).toArray();
  const rubbingIds = rubbings.map((row) => row.id);
  const [losses, seals] = await Promise.all([
    rubbingIds.length > 0 ? db.losses.where('rubbingId').anyOf(rubbingIds).toArray() : Promise.resolve([] as Loss[]),
    rubbingIds.length > 0 ? db.seals.where('rubbingId').anyOf(rubbingIds).toArray() : Promise.resolve([] as Seal[]),
  ]);
  const compares = (await db.compares.where('steleId').equals(steleId).toArray()) as Compare[];
  const tombstoneRows: Tombstone[] = [];
  if (stele) tombstoneRows.push(makeTombstone('steles', stele));
  rubbings.forEach((row) => tombstoneRows.push(makeTombstone('rubbings', row)));
  losses.forEach((row) => tombstoneRows.push(makeTombstone('losses', row)));
  seals.forEach((row) => tombstoneRows.push(makeTombstone('seals', row)));
  compares.forEach((row) => tombstoneRows.push(makeTombstone('compares', row)));

  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.tombstones],
    async () => {
      await db.tombstones.bulkPut(tombstoneRows);
      if (rubbingIds.length > 0) {
        await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
        await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
      }
      await db.rubbings.where('steleId').equals(steleId).delete();
      await db.compares.where('steleId').equals(steleId).delete();
      await db.steles.delete(steleId);
    },
  );
}

/** 级联删除拓本 → 损泐 / 钤印 / 涉及的比对记录；逐层写墓碑 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  const rubbing = await db.rubbings.get(rubbingId);
  const [losses, seals] = await Promise.all([
    db.losses.where('rubbingId').equals(rubbingId).toArray(),
    db.seals.where('rubbingId').equals(rubbingId).toArray(),
  ]);
  const comparesAll = await db.compares.toArray();
  const compares = comparesAll.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
  const tombstoneRows: Tombstone[] = [];
  if (rubbing) tombstoneRows.push(makeTombstone('rubbings', rubbing));
  losses.forEach((row) => tombstoneRows.push(makeTombstone('losses', row)));
  seals.forEach((row) => tombstoneRows.push(makeTombstone('seals', row)));
  compares.forEach((row) => tombstoneRows.push(makeTombstone('compares', row)));

  await db.transaction('rw', [db.rubbings, db.losses, db.seals, db.compares, db.tombstones], async () => {
    await db.tombstones.bulkPut(tombstoneRows);
    await db.losses.where('rubbingId').equals(rubbingId).delete();
    await db.seals.where('rubbingId').equals(rubbingId).delete();
    if (compares.length > 0) await db.compares.bulkDelete(compares.map((row) => row.id));
    await db.rubbings.delete(rubbingId);
  });
}

/** 重排某碑刻下拓本的版本序号，保证连续；仅序号真正变化的记录记一次版本修改 */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  const now = Date.now();
  const changed = sorted
    .map((row, index) => ({ row, nextNo: index + 1 }))
    .filter(({ row, nextNo }) => row.versionNo !== nextNo)
    .map(({ row, nextNo }) => bumpVersion({ ...row, versionNo: nextNo, updatedAt: now }));
  if (changed.length > 0) await db.rubbings.bulkPut(changed);
}
