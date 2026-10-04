/**
 * <SyncPanel> 离线协作包面板
 * - 导出协作包（每张业务记录带共同基准版本，附带删除墓碑）
 * - 导入协作包：按两侧记录对账，单边变化自动应用，双边改动进冲突区
 * - 冲突区按级联组展示本机工作库值 / 协作包值，馆员选定后写入
 * 挂在 /export 页；冲突未决期间持续保留，重复导入同一包直接拒绝。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { liveQuery } from 'dexie';
import { Alert, App as AntdApp, Button, Card, Empty, Space, Table, Tag, Typography } from 'antd';
import {
  CloudUploadOutlined,
  ImportOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useAppDispatch } from '@/stores/store';
import { loadAll } from '@/stores/store';
import { download, stampSuffix } from '@/utils/export';
import { db } from '@/utils/db';
import {
  buildCollabPackage,
  groupConflicts,
  importCollabPackage,
  resolveConflictGroup,
  validateSyncPackage,
  type ConflictGroup,
} from '@/utils/sync';
import {
  SYNC_CONFLICT_KIND_LABEL,
  SYNC_ENTITY_LABEL,
  type AnyBusinessRecord,
  type SyncConflict,
  type SyncEntityName,
  type SyncPackage,
} from '@/types/sync';
import type { Rubbing, RubbingMethod, RubbingState, InkTone } from '@/types/rubbing';
import { INK_TONE_LABEL, RUBBING_METHOD_LABEL, RUBBING_STATE_LABEL } from '@/types/rubbing';
import type { LossType, LossSeverity } from '@/types/loss';
import { LOSS_SEVERITY_LABEL, LOSS_TYPE_LABEL } from '@/types/loss';
import type { SealType } from '@/types/seal';
import { SEAL_TYPE_LABEL } from '@/types/seal';
import type { CompareConclusion } from '@/types/compare';
import { COMPARE_CONCLUSION_LABEL } from '@/types/compare';
import { STELE_FORM_LABEL, type SteleForm } from '@/types/stele';

/* ---------- 记录可读化：冲突表里并排展示字段 ---------- */

type ValueRenderer = (value: unknown) => string;

interface FieldDef {
  label: string;
  render: ValueRenderer;
}

const enumLabel = <T extends string>(map: Record<T, string>): ValueRenderer => {
  return (value) => map[value as T] ?? String(value);
};
const FIELD_DEFS: Partial<Record<string, FieldDef>> = {
  title: { label: '碑名', render: (v) => String(v) },
  era: { label: '年代', render: (v) => String(v) },
  location: { label: '所在地', render: (v) => String(v) },
  form: { label: '形制', render: enumLabel<SteleForm>(STELE_FORM_LABEL) },
  sizeCm: { label: '尺寸', render: (v) => String(v) },
  calligrapher: { label: '书者', render: (v) => String(v) },
  versionNo: { label: '版本序号', render: (v) => `第 ${String(v)} 版` },
  method: { label: '拓法', render: enumLabel<RubbingMethod>(RUBBING_METHOD_LABEL) },
  paperType: { label: '纸种', render: (v) => String(v) },
  inkTone: { label: '墨色', render: enumLabel<InkTone>(INK_TONE_LABEL) },
  collectionNo: { label: '收藏号', render: (v) => String(v) },
  dateGuess: { label: '年代判断', render: (v) => (v ? String(v) : '待考') },
  state: { label: '状态', render: enumLabel<RubbingState>(RUBBING_STATE_LABEL) },
  lineNo: { label: '行号', render: (v) => String(v) },
  charNo: { label: '字位', render: (v) => String(v) },
  type: { label: '类型', render: enumLabel<LossType>(LOSS_TYPE_LABEL) },
  severity: { label: '严重程度', render: enumLabel<LossSeverity>(LOSS_SEVERITY_LABEL) },
  note: { label: '备注', render: (v) => (v ? String(v) : '—') },
  sealText: { label: '印文', render: (v) => String(v) },
  position: { label: '位置', render: (v) => String(v) },
  transcription: { label: '释文', render: (v) => (v ? String(v) : '—') },
  sealType: { label: '印别', render: enumLabel<SealType>(SEAL_TYPE_LABEL) },
  diffCount: { label: '差异字数', render: (v) => `${String(v)} 字` },
  conclusion: { label: '断代结论', render: enumLabel<CompareConclusion>(COMPARE_CONCLUSION_LABEL) },
  operator: { label: '操作人', render: (v) => (v ? String(v) : '未填') },
  date: { label: '比对日期', render: (v) => String(v) },
  rubbingId: { label: '所属拓本', render: (v) => String(v) },
  steleId: { label: '所属碑刻', render: (v) => String(v) },
  rubbingIdA: { label: 'A 拓本', render: (v) => String(v) },
  rubbingIdB: { label: 'B 拓本', render: (v) => String(v) },
};

const ENTITY_FIELDS: Record<SyncEntityName, string[]> = {
  steles: ['title', 'era', 'location', 'form', 'sizeCm', 'calligrapher'],
  rubbings: ['versionNo', 'method', 'paperType', 'inkTone', 'collectionNo', 'dateGuess', 'state'],
  losses: ['lineNo', 'charNo', 'type', 'severity', 'note'],
  seals: ['sealText', 'position', 'sealType', 'transcription'],
  compares: ['diffCount', 'conclusion', 'operator', 'date'],
};

function formatRecord(
  entity: SyncEntityName,
  record: AnyBusinessRecord | null,
  rubbingMap?: Map<string, Rubbing>,
): string {
  if (!record) return '（无记录 · 该侧已删除）';
  const fields = ENTITY_FIELDS[entity];
  const bag = record as unknown as Record<string, unknown>;
  const prefixParts: string[] = [];
  if (entity === 'compares' && rubbingMap) {
    const a = rubbingMap.get(String(bag.rubbingIdA));
    const b = rubbingMap.get(String(bag.rubbingIdB));
    prefixParts.push(`A：${a ? `第 ${a.versionNo} 版` : String(bag.rubbingIdA ?? '?')}`);
    prefixParts.push(`B：${b ? `第 ${b.versionNo} 版` : String(bag.rubbingIdB ?? '?')}`);
  }
  const body = fields
    .map((key) => {
      const def = FIELD_DEFS[key];
      const raw = bag[key];
      if (raw === undefined || raw === null || raw === '') return def ? `${def.label}：—` : '';
      return `${def?.label ?? key}：${def?.render(raw) ?? String(raw)}`;
    })
    .filter((part) => part.length > 0)
    .join('　');
  const version = typeof bag.version === 'number' ? bag.version : 1;
  const base = typeof bag.baseVersion === 'number' ? bag.baseVersion : 1;
  return `${[...prefixParts, body].filter((part) => part.length > 0).join('　')}　〔v${version}/基v${base}〕`;
}

function recordTitle(entity: SyncEntityName, record: AnyBusinessRecord | null): string {
  if (!record) return SYNC_ENTITY_LABEL[entity];
  const bag = record as unknown as Record<string, unknown>;
  if (entity === 'steles') return `碑刻《${String(bag.title ?? '未命名')}》`;
  if (entity === 'rubbings') return `拓本（收藏号 ${String(bag.collectionNo || '未编')}）`;
  if (entity === 'losses') return `损泐字位 第 ${String(bag.lineNo)} 行第 ${String(bag.charNo)} 字`;
  if (entity === 'seals') return `钤印「${String(bag.sealText || '无印文')}」`;
  return `比对记录（${String(bag.date ?? '')}）`;
}

/* ---------- 面板 ---------- */

export default function SyncPanel() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const rubbingTable = useIdbTable<Rubbing>((database) => database.rubbings, { sortByUpdatedAt: false });
  const conflictTable = useIdbTable<SyncConflict>((database) => database.conflicts, { sortByUpdatedAt: false });
  const [ledgerCount, setLedgerCount] = useState(0);

  useEffect(() => {
    const subscription = liveQuery(() => db.packageLedger.count()).subscribe({
      next: (count) => setLedgerCount(count),
      error: () => setLedgerCount(0),
    });
    return () => subscription.unsubscribe();
  }, []);

  const rubbingMap = useMemo(() => new Map(rubbingTable.rows.map((row) => [row.id, row])), [rubbingTable.rows]);
  const groups = useMemo(() => groupConflicts(conflictTable.rows), [conflictTable.rows]);

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const pkg = await buildCollabPackage();
      const filename = `gbrubbing-collab-${stampSuffix()}.json`;
      download(filename, JSON.stringify(pkg, null, 2), 'application/json;charset=utf-8');
      message.success(`已导出协作包 ${filename}（来源 ${pkg.origin}，含墓碑 ${pkg.tombstones.length} 条）`);
    } finally {
      setBusy(false);
    }
  };

  const handleImportClick = (): void => {
    fileRef.current?.click();
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      message.error('JSON 解析失败，请确认文件是协作包');
      return;
    }
    const invalid = validateSyncPackage(parsed);
    if (invalid) {
      message.error(invalid);
      return;
    }
    const pkg = parsed as SyncPackage;
    setBusy(true);
    try {
      const result = await importCollabPackage(pkg);
      await dispatch(loadAll());
      if (result.skipped) {
        message.warning('该协作包此前已导入过，未重复写入任何记录');
      } else if (result.conflictCount > 0) {
        message.warning(
          `已自动应用 ${result.appliedCount} 条单边变化；${result.conflictCount} 条两边都改过，已放入下方冲突区待决议`,
        );
      } else {
        message.success(`协作包合并完成，已应用 ${result.appliedCount} 条单边变化`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '协作包写入失败，已恢复导入前状态');
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async (group: ConflictGroup, choice: 'local' | 'remote'): Promise<void> => {
    setBusy(true);
    try {
      await resolveConflictGroup(group, choice);
      await dispatch(loadAll());
      message.success(choice === 'local' ? '已按本机工作库值写入并解除该组冲突' : '已按协作包值写入并解除该组冲突');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '写入失败，冲突决议未生效');
    } finally {
      setBusy(false);
    }
  };

  const conflictColumns: ColumnsType<ConflictGroup> = [
    {
      title: '冲突记录',
      dataIndex: 'rows',
      render: (_rows, group) => {
        const head = group.rows[0];
        const extra = group.rows.length - 1;
        return (
          <Space direction="vertical" size={2}>
            <Space size={6} wrap>
              <Tag color="orange">{SYNC_ENTITY_LABEL[head.entity]}</Tag>
              <Typography.Text strong>{recordTitle(head.entity, head.localValue ?? head.remoteValue)}</Typography.Text>
              {extra > 0 ? <Tag>关联 {extra} 条级联记录</Tag> : null}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {SYNC_CONFLICT_KIND_LABEL[head.kind]} · 来自协作包 {head.origin}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '本机工作库值',
      key: 'local',
      render: (_v, group) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          {group.rows.map((row) => (
            <Typography.Text
              key={`l-${row.id}`}
              style={{ fontSize: 12, color: row.localValue ? '#2f3a34' : 'rgba(0,0,0,0.35)' }}
            >
              {group.rows.length > 1 ? `${SYNC_ENTITY_LABEL[row.entity]}：` : ''}
              {formatRecord(row.entity, row.localValue, rubbingMap)}
            </Typography.Text>
          ))}
        </Space>
      ),
    },
    {
      title: '协作包值',
      key: 'remote',
      render: (_v, group) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          {group.rows.map((row) => (
            <Typography.Text
              key={`r-${row.id}`}
              style={{ fontSize: 12, color: row.remoteValue ? '#3a6ea5' : 'rgba(0,0,0,0.35)' }}
            >
              {group.rows.length > 1 ? `${SYNC_ENTITY_LABEL[row.entity]}：` : ''}
              {formatRecord(row.entity, row.remoteValue, rubbingMap)}
            </Typography.Text>
          ))}
        </Space>
      ),
    },
    {
      title: '决议后写入',
      key: 'action',
      width: 210,
      render: (_v, group) => (
        <Space direction="vertical" size={4}>
          <Button
            size="small"
            block
            disabled={busy}
            onClick={() => void handleResolve(group, 'local')}
          >
            采用本机值
          </Button>
          <Button
            size="small"
            block
            type="primary"
            ghost
            disabled={busy}
            onClick={() => void handleResolve(group, 'remote')}
          >
            采用协作包值
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="馆员离线协作包" size="small">
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            导出时每张业务记录带共同基准版本与删除墓碑；另一台电脑导入后按两侧记录对账：单边变化自动合并，同一记录两边都改过则进入冲突区，选定后才写入。
          </Typography.Text>
          <Space wrap>
            <Button type="primary" icon={<CloudUploadOutlined />} loading={busy} onClick={() => void handleExport()}>
              导出协作包
            </Button>
            <Button icon={<ImportOutlined />} loading={busy} onClick={handleImportClick}>
              导入协作包并对账
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(event) => void handleFile(event)}
            />
          </Space>
          {ledgerCount > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已登记 {ledgerCount} 个协作包，重复导入同一包不会重复新增。
            </Typography.Text>
          ) : null}
        </Space>
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <WarningOutlined style={{ color: groups.length > 0 ? '#c9963c' : undefined }} />
            <span>冲突区</span>
            {groups.length > 0 ? <Tag color="orange">{conflictTable.rows.length} 条未决 / {groups.length} 组</Tag> : null}
          </Space>
        }
      >
        {groups.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="没有未决冲突。同一记录两边都改过（或一边删一边改）时会在此并排显示，选定后写入。"
          />
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="以下记录两边存在差异，尚未写入本机工作库"
              description="碑刻 / 拓本删除会沿业务关系把关联记录编为同一组，请整组选择；未决议前冲突将一直保留。"
            />
            <Table<ConflictGroup>
              rowKey="groupId"
              size="small"
              pagination={false}
              columns={conflictColumns}
              dataSource={groups}
            />
          </Space>
        )}
      </Card>
    </Space>
  );
}
