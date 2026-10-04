/**
 * 协作记录字段元数据
 * 把五张业务表的字段统一成「字段名 → 中文标签 + 值格式化」，
 * 供冲突区并排展示本机工作库 / 协作包两侧取值，以及编目卡标注来源版本。
 */
import type { Stele, SteleForm } from '@/types/stele';
import type { Rubbing, RubbingMethod, InkTone, RubbingState } from '@/types/rubbing';
import type { Loss, LossType, LossSeverity } from '@/types/loss';
import type { Seal, SealType } from '@/types/seal';
import type { Compare, CompareConclusion } from '@/types/compare';
import type { SyncCollections, SyncRecord, SyncTable } from '@/types/sync';
import { STELE_FORM_LABEL } from '@/types/stele';
import { INK_TONE_LABEL, RUBBING_METHOD_LABEL, RUBBING_STATE_LABEL } from '@/types/rubbing';
import { LOSS_SEVERITY_LABEL, LOSS_TYPE_LABEL } from '@/types/loss';
import { SEAL_TYPE_LABEL } from '@/types/seal';
import { COMPARE_CONCLUSION_LABEL } from '@/types/compare';
import { encodeCoord } from './collate';

export const SYNC_TABLE_LABEL: Record<SyncTable, string> = {
  steles: '碑刻',
  rubbings: '拓本',
  losses: '损泐字位',
  seals: '钤印',
  compares: '版本比对',
};

export interface FieldDef {
  key: string;
  label: string;
}

/** 冲突对照时逐字段展示的字段顺序（id / 时间戳 / 基准版本之外的业务字段） */
export const SYNC_FIELDS: Record<SyncTable, FieldDef[]> = {
  steles: [
    { key: 'title', label: '碑名' },
    { key: 'era', label: '年代' },
    { key: 'location', label: '所在地' },
    { key: 'form', label: '形制' },
    { key: 'sizeCm', label: '尺寸' },
    { key: 'calligrapher', label: '书者' },
  ],
  rubbings: [
    { key: 'versionNo', label: '版本序号' },
    { key: 'method', label: '拓法' },
    { key: 'paperType', label: '纸种' },
    { key: 'inkTone', label: '墨色' },
    { key: 'sizeCm', label: '尺寸' },
    { key: 'collectionNo', label: '收藏号' },
    { key: 'dateGuess', label: '年代判断' },
    { key: 'state', label: '状态' },
  ],
  losses: [
    { key: 'lineNo', label: '行号' },
    { key: 'charNo', label: '字位' },
    { key: 'type', label: '损泐类型' },
    { key: 'severity', label: '严重程度' },
    { key: 'note', label: '释文备注' },
  ],
  seals: [
    { key: 'sealText', label: '印文' },
    { key: 'position', label: '位置' },
    { key: 'sealType', label: '印别' },
    { key: 'transcription', label: '释文' },
  ],
  compares: [
    { key: 'rubbingIdA', label: '拓本 A' },
    { key: 'rubbingIdB', label: '拓本 B' },
    { key: 'diffCount', label: '差异字数' },
    { key: 'conclusion', label: '断代结论' },
    { key: 'operator', label: '操作人' },
    { key: 'date', label: '比对日期' },
  ],
};

function formatEnum(table: SyncTable, key: string, value: unknown, ctx: SyncCollections): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (table) {
    case 'steles':
      if (key === 'form') return STELE_FORM_LABEL[value as SteleForm];
      break;
    case 'rubbings':
      if (key === 'method') return RUBBING_METHOD_LABEL[value as RubbingMethod];
      if (key === 'inkTone') return INK_TONE_LABEL[value as InkTone];
      if (key === 'state') return RUBBING_STATE_LABEL[value as RubbingState];
      break;
    case 'losses':
      if (key === 'type') return LOSS_TYPE_LABEL[value as LossType];
      if (key === 'severity') return LOSS_SEVERITY_LABEL[value as LossSeverity];
      break;
    case 'seals':
      if (key === 'sealType') return SEAL_TYPE_LABEL[value as SealType];
      break;
    case 'compares':
      if (key === 'conclusion') return COMPARE_CONCLUSION_LABEL[value as CompareConclusion];
      if (key === 'rubbingIdA' || key === 'rubbingIdB') {
        const rub = ctx.rubbings.find((item) => item.id === value);
        return rub ? `第 ${(rub as Rubbing).versionNo} 版` : '已删除拓本';
      }
      break;
    default:
      break;
  }
  return String(value);
}

/** 读取一条记录某字段的展示文案 */
export function formatField(table: SyncTable, key: string, record: SyncRecord, ctx: SyncCollections): string {
  const value = (record as unknown as Record<string, unknown>)[key];
  return formatEnum(table, key, value, ctx);
}

/** 来源版本文案：共同基准版本号 */
export function sourceVersionLabel(record: SyncRecord | null): string {
  return record ? `来源版本 v${record.baseVersion}` : '已删除';
}

interface RelationContext {
  steles: Stele[];
  rubbings: Rubbing[];
}

/** 解析任意业务记录锚定的碑刻 id（「墓碑」归属） */
export function resolveSteleId(table: SyncTable, record: SyncRecord, ctx: RelationContext): string | null {
  switch (table) {
    case 'steles':
      return record.id;
    case 'rubbings':
      return (record as Rubbing).steleId;
    case 'losses':
    case 'seals': {
      const rubbingId = (record as Loss | Seal).rubbingId;
      const rubbing = ctx.rubbings.find((item) => item.id === rubbingId);
      return rubbing?.steleId ?? null;
    }
    case 'compares':
      return (record as Compare).steleId;
    default:
      return null;
  }
}

/** 记录摘要，冲突列表 / 变化清单直接展示 */
export function recordLabel(table: SyncTable, record: SyncRecord, ctx: RelationContext): string {
  switch (table) {
    case 'steles':
      return (record as Stele).title || record.id;
    case 'rubbings': {
      const rub = record as Rubbing;
      const stele = ctx.steles.find((item) => item.id === rub.steleId);
      return `${stele?.title ?? rub.steleId} · 第 ${rub.versionNo} 版`;
    }
    case 'losses': {
      const loss = record as Loss;
      return `损泐 ${encodeCoord(loss.lineNo, loss.charNo)}（${LOSS_TYPE_LABEL[loss.type]}·${LOSS_SEVERITY_LABEL[loss.severity]}）`;
    }
    case 'seals': {
      const seal = record as Seal;
      return `钤印 ${seal.sealText || '未填印文'}（${seal.position}）`;
    }
    case 'compares': {
      const compare = record as Compare;
      const a = ctx.rubbings.find((item) => item.id === compare.rubbingIdA)?.versionNo ?? '?';
      const b = ctx.rubbings.find((item) => item.id === compare.rubbingIdB)?.versionNo ?? '?';
      return `比对 第${a}版 / 第${b}版（${compare.date}）`;
    }
    default:
      return record.id;
  }
}
