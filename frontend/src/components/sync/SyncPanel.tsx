/**
 * 协作包导出 / 导入面板
 * - 导出：给每张业务记录带上共同基准版本与碑刻锚点，并附上共同基准快照
 * - 导入：读包后先三方对账并预览单边变化 / 冲突数，确认后在单事务内应用
 * - 重复包识别、引用不全拒绝、写入失败回滚由 utils/sync 保证
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Alert, App as AntdApp, Badge, Button, Card, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { CloudDownloadOutlined, CloudUploadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { loadAll } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings, selectSeals } from '@/stores/rubbingSlice';
import { selectCompares, selectLosses } from '@/stores/lossSlice';
import { readBusinessCollections, listSyncConflicts } from '@/utils/db';
import {
  applyMergePlan,
  buildMergePlan,
  exportSyncPackage,
  findReferenceGaps,
  isPackageApplied,
  validateSyncPackage,
  type MergePlan,
  type SyncChange,
  type SyncPackage,
} from '@/utils/sync';
import { exportSyncPackageFile } from '@/utils/export';
import { SYNC_TABLE_LABEL } from '@/utils/syncFields';
import type { SyncTable } from '@/types/sync';

const CHANGE_LABEL: Record<SyncChange['action'], string> = {
  upsert: '新增 / 更新',
  delete: '删除',
};

const CHANGE_COLOR: Record<SyncChange['action'], string> = {
  upsert: 'green',
  delete: 'red',
};

export default function SyncPanel() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const fileRef = useRef<HTMLInputElement>(null);

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const seals = useAppSelector(selectSeals);
  const losses = useAppSelector(selectLosses);
  const compares = useAppSelector(selectCompares);

  const [producer, setProducer] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [pkg, setPkg] = useState<SyncPackage | null>(null);

  const recordCount = steles.length + rubbings.length + seals.length + losses.length + compares.length;

  const countSummary = useMemo(() => {
    if (!plan) return null;
    return (Object.keys(plan.counts) as SyncTable[]).map((table) => ({
      key: table,
      table: SYNC_TABLE_LABEL[table],
      local: plan.counts[table].local,
      incoming: plan.counts[table].incoming,
      changes: plan.changes.filter((change) => change.table === table).length,
    }));
  }, [plan]);

  const handleExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const next = await exportSyncPackage(producer);
      const filename = exportSyncPackageFile(next);
      message.success(`已导出协作包 ${filename}（${next.producer}），含 ${recordCount} 条业务记录与共同基准`);
    } catch (error) {
      message.error(`导出协作包失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setExporting(false);
    }
  };

  const handlePickFile = (): void => fileRef.current?.click();

  const handleFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const invalid = validateSyncPackage(parsed);
      if (invalid) {
        message.error(invalid);
        return;
      }
      const nextPkg = parsed as SyncPackage;
      if (await isPackageApplied(nextPkg.packageId)) {
        Modal.info({
          title: '该协作包已合入过',
          content: `协作包 ${nextPkg.packageId}（${nextPkg.producer}）已应用，重复导入不会重复新增记录。`,
          okText: '知道了',
        });
        return;
      }
      const gaps = findReferenceGaps(nextPkg);
      if (gaps.length > 0) {
        Modal.error({
          title: '协作包引用不全，已取消导入',
          width: 560,
          content: (
            <Space direction="vertical" size={4}>
              <Typography.Text type="secondary">包内子记录引用了不在包中的父记录，未写入任何数据：</Typography.Text>
              {gaps.slice(0, 8).map((gap) => (
                <Typography.Text key={gap} type="danger">
                  · {gap}
                </Typography.Text>
              ))}
              {gaps.length > 8 ? <Typography.Text type="secondary">…等 {gaps.length} 处</Typography.Text> : null}
            </Space>
          ),
        });
        return;
      }
      const local = await readBusinessCollections();
      const existingConflictKeys = new Set((await listSyncConflicts()).map((row) => `${row.table}:${row.recordId}`));
      const nextPlan = buildMergePlan(nextPkg, local, { existingConflictKeys });
      setPkg(nextPkg);
      setPlan(nextPlan);
    } catch {
      message.error('协作包解析失败，请确认文件为导出的 JSON 协作包');
    } finally {
      setImporting(false);
    }
  };

  const handleApply = async (): Promise<void> => {
    if (!plan) return;
    setApplying(true);
    try {
      await applyMergePlan(plan);
      await dispatch(loadAll());
      message.success(
        plan.conflicts.length > 0
          ? `已应用 ${plan.changes.length} 条单边变化，${plan.conflicts.length} 条冲突已放入冲突区待选定`
          : `已应用 ${plan.changes.length} 条单边变化，无冲突`,
      );
      setPlan(null);
      setPkg(null);
    } catch (error) {
      // 事务整体回滚：本机库已恢复到导入前状态
      message.error(`写入失败，已恢复导入前状态：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setApplying(false);
    }
  };

  const changeColumns: ColumnsType<SyncChange> = [
    {
      title: '类型',
      dataIndex: 'table',
      width: 100,
      render: (value: SyncTable) => <Tag>{SYNC_TABLE_LABEL[value]}</Tag>,
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 110,
      render: (value: SyncChange['action']) => <Tag color={CHANGE_COLOR[value]}>{CHANGE_LABEL[value]}</Tag>,
    },
    { title: '记录', dataIndex: 'label' },
    {
      title: '应用后基准版本',
      dataIndex: 'nextBaseVersion',
      width: 130,
      render: (value: number) => `v${value}`,
    },
  ];

  return (
    <Card title="协作包（离线补录对账）">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="三方对账，不覆盖前人内容"
          description="协作包为每张记录携带共同基准版本与所属碑刻；导入时只应用单边变化，同一记录两边都改过会进入冲突区，由人工分别查看本机与协作包取值后再写入。"
        />
        <Space wrap>
          <Input
            style={{ width: 200 }}
            placeholder="本机署名（如：傅砚·馆内机）"
            value={producer}
            maxLength={24}
            onChange={(event) => setProducer(event.target.value)}
          />
          <Button type="primary" icon={<CloudDownloadOutlined />} loading={exporting} onClick={() => void handleExport()}>
            导出协作包
          </Button>
          <Button icon={<CloudUploadOutlined />} loading={importing} onClick={handlePickFile}>
            导入协作包
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => void handleFile(event)}
          />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          本机当前 {recordCount} 条业务记录；重复导入同一个包会被识别而不重复新增。
        </Typography.Text>
      </Space>

      <Modal
        open={plan !== null}
        title={`对账预览 · ${pkg?.producer ?? ''} 的协作包`}
        width={820}
        okText={`应用 ${plan?.changes.length ?? 0} 条单边变化`}
        cancelText="取消"
        confirmLoading={applying}
        okButtonProps={{ danger: false }}
        onCancel={() => {
          setPlan(null);
          setPkg(null);
        }}
        onOk={() => void handleApply()}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            包导出时间 {pkg?.exportedAt ? new Date(pkg.exportedAt).toLocaleString('zh-CN') : '—'}　共同基准时间{' '}
            {pkg?.baselineAt ? new Date(pkg.baselineAt).toLocaleString('zh-CN') : '—'}
          </Typography.Text>
          {countSummary ? (
            <Table
              size="small"
              pagination={false}
              rowKey="key"
              dataSource={countSummary}
              columns={[
                { title: '表', dataIndex: 'table', width: 120 },
                { title: '本机记录', dataIndex: 'local', width: 100 },
                { title: '包内记录', dataIndex: 'incoming', width: 100 },
                { title: '单边变化', dataIndex: 'changes', width: 100, render: (v: number) => <Badge count={v} showZero color="#2f6f4f" /> },
              ]}
            />
          ) : null}
          {plan && plan.conflicts.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`${plan.conflicts.length} 条记录两边都改过，将放入冲突区`}
              description="这些记录不会被自动覆盖；导入后请到下方「协作冲突区」并排查看本机工作库与协作包的值，逐条选定再写入。未决冲突会继续保留。"
            />
          ) : (
            <Alert type="success" showIcon message="没有双边修改冲突" description="所有差异均为单边变化，可直接应用。" />
          )}
          <Table<SyncChange>
            size="small"
            rowKey={(row) => `${row.table}:${row.recordId}:${row.action}`}
            pagination={{ pageSize: 6 }}
            columns={changeColumns}
            dataSource={plan?.changes ?? []}
            locale={{ emptyText: '没有需要应用的单边变化（两边一致或仅本机改动）' }}
          />
        </Space>
      </Modal>
    </Card>
  );
}
