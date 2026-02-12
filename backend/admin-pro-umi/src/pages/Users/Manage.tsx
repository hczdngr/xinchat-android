import { ExclamationCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { UserBatchAction, UserDetail, UserSummaryItem, UsersSummary } from '@/services/admin/api';
import {
  batchUsersAction,
  fetchUserDetail,
  fetchUsers,
  fetchUsersSummary,
  revokeAllUserSessions,
  softDeleteUser,
  updateUser,
} from '@/services/admin/api';

const statusColor: Record<string, string> = {
  active: 'success',
  blocked: 'warning',
  deleted: 'error',
};

const statusLabel: Record<string, string> = {
  active: '正常',
  blocked: '封禁',
  deleted: '已删除',
};

const initialQuery = {
  page: 1,
  pageSize: 20,
  q: '',
  status: 'all',
};

const UsersManage: React.FC = () => {
  const { message, modal } = App.useApp();
  const [summary, setSummary] = useState<UsersSummary | null>(null);
  const [rows, setRows] = useState<UserSummaryItem[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<UserDetail | null>(null);

  const [editVisible, setEditVisible] = useState(false);
  const [editing, setEditing] = useState<UserSummaryItem | null>(null);
  const [editForm] = Form.useForm();

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryResp, usersResp] = await Promise.all([
        fetchUsersSummary(),
        fetchUsers(query),
      ]);
      setSummary(summaryResp.data || null);
      const pageData = usersResp.data;
      setRows(Array.isArray(pageData?.items) ? pageData.items : []);
      setTotal(Number(pageData?.total || 0));
    } catch (error) {
      const text =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      message.error(text || '用户数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openDetail = async (uid: number) => {
    setDetailVisible(true);
    setDetailLoading(true);
    try {
      const resp = await fetchUserDetail(uid);
      setDetail(resp.data || null);
    } catch (error) {
      const text =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      message.error(text || '用户详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const openEdit = (record: UserSummaryItem) => {
    setEditing(record);
    editForm.setFieldsValue({
      nickname: record.nickname,
      signature: record.signature,
      domain: record.domain,
      status: record.status,
    });
    setEditVisible(true);
  };

  const submitEdit = async () => {
    if (!editing) return;
    const values = await editForm.validateFields();
    await updateUser({
      uid: editing.uid,
      nickname: values.nickname,
      signature: values.signature,
      domain: values.domain,
      status: values.status,
    });
    message.success('用户资料已更新');
    setEditVisible(false);
    setEditing(null);
    await reload();
  };

  const runBatch = async (action: UserBatchAction) => {
    const uids = selectedRowKeys.map((item) => Number(item)).filter((item) => item > 0);
    if (!uids.length) {
      message.warning('请先勾选用户');
      return;
    }
    await batchUsersAction(action, uids);
    message.success(`批量操作 ${action} 已执行`);
    setSelectedRowKeys([]);
    await reload();
  };

  const confirmBatch = (action: UserBatchAction, title: string) => {
    modal.confirm({
      title,
      icon: <ExclamationCircleFilled />,
      content: `共 ${selectedRowKeys.length} 个用户`,
      onOk: () => runBatch(action),
    });
  };

  const columns: ColumnsType<UserSummaryItem> = useMemo(
    () => [
      {
        title: 'UID',
        dataIndex: 'uid',
        width: 120,
      },
      {
        title: '用户名',
        dataIndex: 'username',
        width: 160,
      },
      {
        title: '昵称',
        dataIndex: 'nickname',
        width: 180,
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 110,
        render: (value: string) => (
          <Tag color={statusColor[value] || 'default'}>{statusLabel[value] || value}</Tag>
        ),
      },
      {
        title: '在线',
        dataIndex: 'online',
        width: 90,
        render: (value: boolean) => (value ? <Tag color="green">在线</Tag> : <Tag>离线</Tag>),
      },
      {
        title: '好友数',
        dataIndex: 'friendsCount',
        width: 100,
      },
      {
        title: '会话数',
        dataIndex: 'tokenCount',
        width: 100,
      },
      {
        title: '域名',
        dataIndex: 'domain',
        ellipsis: true,
      },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 340,
        render: (_, record) => (
          <Space size="small" wrap>
            <Button size="small" onClick={() => void openDetail(record.uid)}>
              详情
            </Button>
            <Button size="small" onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Button
              size="small"
              onClick={async () => {
                await revokeAllUserSessions(record.uid);
                message.success('已撤销该用户所有会话');
                await reload();
              }}
            >
              强制下线
            </Button>
            {record.status === 'deleted' ? (
              <Button
                size="small"
                onClick={async () => {
                  await softDeleteUser(record.uid, true);
                  message.success('用户已恢复');
                  await reload();
                }}
              >
                恢复
              </Button>
            ) : (
              <Popconfirm
                title="确认软删除该用户?"
                onConfirm={async () => {
                  await softDeleteUser(record.uid, false);
                  message.success('用户已软删除');
                  await reload();
                }}
              >
                <Button size="small" danger>
                  软删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        ),
      },
    ],
    [message, modal, reload],
  );

  return (
    <PageContainer
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
      ]}
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={4}>
          <Card><Statistic title="总用户" value={summary?.total || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
          <Card><Statistic title="在线" value={summary?.online || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
          <Card><Statistic title="封禁" value={summary?.blocked || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
          <Card><Statistic title="已删" value={summary?.deleted || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
          <Card><Statistic title="活跃" value={summary?.active || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={4}>
          <Card><Statistic title="Token" value={summary?.tokens || 0} /></Card>
        </Col>
      </Row>

      <Card style={{ marginTop: 16 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search
            allowClear
            placeholder="搜索 UID/用户名/昵称/域名"
            style={{ width: 280 }}
            onSearch={(value) => setQuery((prev) => ({ ...prev, q: value.trim(), page: 1 }))}
          />
          <Select
            value={query.status}
            style={{ width: 160 }}
            options={[
              { label: '全部状态', value: 'all' },
              { label: '正常', value: 'active' },
              { label: '封禁', value: 'blocked' },
              { label: '已删除', value: 'deleted' },
            ]}
            onChange={(value) => setQuery((prev) => ({ ...prev, status: value, page: 1 }))}
          />
          <Button onClick={() => confirmBatch('activate', '批量激活选中用户')}>批量激活</Button>
          <Button onClick={() => confirmBatch('block', '批量封禁选中用户')}>批量封禁</Button>
          <Button onClick={() => confirmBatch('restore', '批量恢复选中用户')}>批量恢复</Button>
          <Button danger onClick={() => confirmBatch('soft-delete', '批量软删除选中用户')}>
            批量软删除
          </Button>
          <Button onClick={() => confirmBatch('revoke-sessions', '批量撤销选中用户会话')}>
            批量下线
          </Button>
        </Space>

        <Table<UserSummaryItem>
          rowKey="uid"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1400 }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
          }}
          pagination={{
            current: query.page,
            pageSize: query.pageSize,
            total,
            showSizeChanger: true,
            onChange: (page, pageSize) => setQuery((prev) => ({ ...prev, page, pageSize })),
          }}
        />
      </Card>

      <Drawer
        open={detailVisible}
        onClose={() => setDetailVisible(false)}
        title={detail ? `用户详情 #${detail.uid}` : '用户详情'}
        width={520}
        loading={detailLoading}
      >
        {detail ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="用户名">{detail.username}</Descriptions.Item>
            <Descriptions.Item label="昵称">{detail.nickname}</Descriptions.Item>
            <Descriptions.Item label="签名">{detail.signature || '-'}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={statusColor[detail.status] || 'default'}>{statusLabel[detail.status] || detail.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="在线">{detail.online ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="好友数">{detail.friendsCount}</Descriptions.Item>
            <Descriptions.Item label="Token 数">{detail.tokenCount}</Descriptions.Item>
            <Descriptions.Item label="域名">{detail.domain || '-'}</Descriptions.Item>
            <Descriptions.Item label="地区">
              {`${detail.country || ''} ${detail.province || ''} ${detail.region || ''}`.trim() || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">{detail.createdAt || '-'}</Descriptions.Item>
            <Descriptions.Item label="最近登录">{detail.lastLoginAt || '-'}</Descriptions.Item>
            <Descriptions.Item label="AI Profile 更新时间">{detail.aiProfileUpdatedAt || '-'}</Descriptions.Item>
            <Descriptions.Item label="助手偏好">
              <Space wrap>
                <Tag>reply: {detail.assistantProfile?.replyStyle || '-'}</Tag>
                <Tag>translate: {detail.assistantProfile?.translateStyle || '-'}</Tag>
                <Tag>explain: {detail.assistantProfile?.explanationLevel || '-'}</Tag>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="抑郁评级">
              <Space direction="vertical" size={4}>
                <Typography.Text>
                  level: {detail.depressionRating?.level || 'unknown'}
                  {typeof detail.depressionRating?.score === 'number'
                    ? ` (score=${detail.depressionRating?.score})`
                    : ''}
                </Typography.Text>
                <Typography.Text type="secondary">{detail.depressionRating?.reason || '-'}</Typography.Text>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="VW个性化标签">
              {detail.recoPersona?.topTags?.length ? (
                <Space wrap>
                  {detail.recoPersona?.topTags?.slice(0, 12).map((tag) => (
                    <Tag key={`${tag.name}-${tag.weight}`} color={tag.polarity === 'positive' ? 'green' : 'red'}>
                      {tag.name} ({Number(tag.weight || 0).toFixed(2)})
                    </Tag>
                  ))}
                </Space>
              ) : (
                '-'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="AI画像摘要">
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                {detail.aiProfile?.profileSummary || '-'}
              </Typography.Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label="AI画像详情">
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(detail.aiProfile?.raw || {}, null, 2)}
              </pre>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">暂无数据</Typography.Text>
        )}
      </Drawer>

      <Modal
        open={editVisible}
        title={editing ? `编辑用户 #${editing.uid}` : '编辑用户'}
        onCancel={() => {
          setEditVisible(false);
          setEditing(null);
        }}
        onOk={() => {
          void submitEdit();
        }}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="昵称" name="nickname" rules={[{ required: true, message: '请输入昵称' }]}> 
            <Input maxLength={36} />
          </Form.Item>
          <Form.Item label="签名" name="signature">
            <Input.TextArea rows={3} maxLength={80} showCount />
          </Form.Item>
          <Form.Item label="域名" name="domain">
            <Input maxLength={253} />
          </Form.Item>
          <Form.Item label="状态" name="status" rules={[{ required: true, message: '请选择状态' }]}>
            <Select
              options={[
                { label: '正常', value: 'active' },
                { label: '封禁', value: 'blocked' },
                { label: '已删除', value: 'deleted' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
};

export default UsersManage;
