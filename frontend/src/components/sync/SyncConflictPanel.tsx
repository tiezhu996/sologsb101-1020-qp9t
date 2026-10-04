/**
 * 协作冲突区
 * 同一记录两边都改过（或一改一删、各自新建）时进入此处；
 * 并排显示「本机工作库」与「协作包」两侧取值（含字段差异高亮），选定后才写入。
 * 未决冲突跨次导入继续保留，直到逐条采用某一侧或放弃登记。
 */
import { useMemo, useState } from 'react';
import { Alert, App as AntdApp, Button, Card, Empty, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { discardSyncConflict, resolveSyncConflict, selectSyncConflicts } from '@/stores/syncSlice';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings, selectSeals } from '@/stores/rubbingSlice';
import { selectCompares, selectLosses } from '@/stores/lossSlice';
import type { SyncConflict, SyncRecord, SyncTable } from '@/types/sync';
import { SYNC_CONFLICT_KIND_LABEL } from '@/types/sync';
import { formatField, SYNC_FIELDS, SYNC_TABLE_LABEL } from '@/utils/syncFields';
import type { SyncCollections } from '@/types/sync';

const KIND_COLOR: Record<SyncConflict['kind'], string> = {
  'modify-modify': 'volcano',
  'modify-delete': 'orange',
  'create-create': 'geekblue',
};

/** 单侧取值：逐字段渲染，删除侧显示占位 */
function SideValue({
  conflict,
  side,
  ctx,
}: {
  conflict: SyncConflict;
  side: 'local' | 'incoming';
  ctx: SyncCollections;
}) {
  const record = conflict[side];
  if (!record) {
    return <Tag color="red">该侧已删除</Tag>;
  }
  const fields = SYNC_FIELDS[conflict.table];
  const other = conflict[side === 'local' ? 'incoming' : 'local'];
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <Tag color={side === 'local' ? '#2f3a34' : '#a8623a'}>{side === 'local' ? '本机工作库' : '协作包'} · v{record.baseVersion}</Tag>
      {fields.map((field) => {
        const value = formatField(conflict.table, field.key, record as SyncRecord, ctx);
        const differs = other
          ? formatField(conflict.table, field.key, other as SyncRecord, ctx) !== value
          : true;
        return (
          <div key={field.key} style={{ fontSize: 12, background: differs ? 'rgba(176,58,46,0.08)' : undefined, padding: '1px 4px', borderRadius: 3 }}>
            <Typography.Text type="secondary">{field.label}：</Typography.Text>
            <Typography.Text strong={differs}>{value}</Typography.Text>
          </div>
        );
      })}
    </Space>
  );
}

export default function SyncConflictPanel() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const conflicts = useAppSelector(selectSyncConflicts);
  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const seals = useAppSelector(selectSeals);
  const losses = useAppSelector(selectLosses);
  const compares = useAppSelector(selectCompares);
  const [resolving, setResolving] = useState<string | null>(null);

  // 字段格式化需要完整五表作为上下文（含删除拓本时的回退显示）
  const ctx: SyncCollections = useMemo(
    () => ({ steles, rubbings, losses, seals, compares }),
    [compares, losses, rubbings, seals, steles],
  );

  const steleName = (id: string | null): string => steles.find((item) => item.id === id)?.title ?? '未挂碑刻 / 已删除';

  const handleResolve = async (conflict: SyncConflict, resolution: 'local' | 'incoming'): Promise<void> => {
    setResolving(conflict.id);
    try {
      await dispatch(resolveSyncConflict({ conflictId: conflict.id, resolution })).unwrap();
      message.success(`已按${resolution === 'local' ? '本机工作库' : '协作包'}的值写入：${conflict.label}`);
    } finally {
      setResolving(null);
    }
  };

  const columns: ColumnsType<SyncConflict> = [
    {
      title: '碑刻 / 表',
      width: 170,
      render: (_v, record) => (
        <Space direction="vertical" size={2}>
          <Tag>{SYNC_TABLE_LABEL[record.table as SyncTable]}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {steleName(record.steleId)}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '记录', dataIndex: 'label', width: 200 },
    {
      title: '冲突',
      dataIndex: 'kind',
      width: 110,
      render: (value: SyncConflict['kind']) => <Tag color={KIND_COLOR[value]}>{SYNC_CONFLICT_KIND_LABEL[value]}</Tag>,
    },
    {
      title: '本机工作库',
      width: 230,
      render: (_v, record) => <SideValue conflict={record} side="local" ctx={ctx} />,
    },
    {
      title: '协作包',
      width: 230,
      render: (_v, record) => <SideValue conflict={record} side="incoming" ctx={ctx} />,
    },
    {
      title: '选定后写入',
      key: 'action',
      width: 210,
      render: (_v, record) => (
        <Space direction="vertical" size={4}>
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<CheckOutlined />}
              loading={resolving === record.id}
              onClick={() => void handleResolve(record, 'local')}
            >
              用本机
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={resolving === record.id}
              onClick={() => void handleResolve(record, 'incoming')}
            >
              用协作包
            </Button>
          </Space>
          <Popconfirm
            title="放弃该冲突登记？"
            description="仅移除冲突条目，不会改动两边的业务记录。"
            okText="放弃"
            cancelText="取消"
            onConfirm={() =>
              void dispatch(discardSyncConflict(record.id))
                .unwrap()
                .then(() => message.success('已移除冲突登记'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              放弃
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      style={{ marginTop: 16 }}
      title={
        <Space>
          协作冲突区
          <Tag color={conflicts.length > 0 ? 'volcano' : 'default'}>{conflicts.length} 条未决</Tag>
        </Space>
      }
    >
      {conflicts.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="没有未决冲突。同一记录两边都改过的情况会出现在这里，选定后才写入。"
        />
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            icon={<CloseOutlined />}
            message="以下记录在两台电脑上被改出差异，系统未自动覆盖任何一侧"
            description="高亮字段为两侧取值不同处；选择「用本机」或「用协作包」后才写入业务库。未选定的冲突会持续保留，不影响其它单边变化的导入。"
          />
          <Table<SyncConflict>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 5 }}
            columns={columns}
            dataSource={conflicts}
            scroll={{ x: 1180 }}
          />
        </Space>
      )}
    </Card>
  );
}
