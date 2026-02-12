import { ReloadOutlined } from '@ant-design/icons';
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
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MessageItem,
  MessageReviewStatus,
  MessagesSummary,
  RiskLevel,
} from '@/services/admin/api';
import {
  deleteMessageAsAdmin,
  fetchMessageDetail,
  fetchMessages,
  fetchMessagesSummary,
  reviewMessage,
} from '@/services/admin/api';

const statusColor: Record<string, string> = {
  unreviewed: 'default',
  approved: 'success',
  flagged: 'warning',
  blocked: 'error',
  deleted: 'error',
};

const riskColor: Record<string, string> = {
  low: 'default',
  medium: 'warning',
  high: 'error',
};

const queryInit = {
  page: 1,
  pageSize: 20,
  q: '',
  type: 'all',
  targetType: 'all',
  reviewStatus: 'all',
  riskLevel: 'all',
};

const MessagesReview: React.FC = () => {
  const { message } = App.useApp();
  const [summary, setSummary] = useState<MessagesSummary | null>(null);
  const [rows, setRows] = useState<MessageItem[]>([]);
  const [query, setQuery] = useState(queryInit);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);

  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<MessageItem | null>(null);

  const [reviewVisible, setReviewVisible] = useState(false);
  const [reviewing, setReviewing] = useState<MessageItem | null>(null);
  const [reviewForm] = Form.useForm();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryResp, listResp] = await Promise.all([
        fetchMessagesSummary(24),
        fetchMessages({
          ...query,
          type: query.type === 'all' ? '' : query.type,
          targetType: query.targetType === 'all' ? '' : query.targetType,
          reviewStatus: query.reviewStatus === 'all' ? '' : query.reviewStatus,
          riskLevel: query.riskLevel === 'all' ? '' : query.riskLevel,
        }),
      ]);
      setSummary(summaryResp.data || null);
      const pageData = listResp.data;
      setRows(Array.isArray(pageData?.items) ? pageData.items : []);
      setTotal(Number(pageData?.total || 0));
    } catch (error) {
      const text =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      message.error(text || '消息审查数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openDetail = async (id: string) => {
    setDetailVisible(true);
    setDetailLoading(true);
    try {
      const resp = await fetchMessageDetail(id);
      setDetail(resp.data || null);
    } catch (error) {
      const text =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      message.error(text || '消息详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const openReview = (item: MessageItem) => {
    setReviewing(item);
    reviewForm.setFieldsValue({
      status: item.reviewStatus === 'unreviewed' ? 'approved' : item.reviewStatus || 'approved',
      riskLevel: item.riskLevel || 'low',
      reason: item.review?.reason || '',
      tags: Array.isArray(item.review?.tags) ? item.review?.tags.join(',') : '',
    });
    setReviewVisible(true);
  };

  const submitReview = async () => {
    if (!reviewing) return;
    const values = await reviewForm.validateFields();
    await reviewMessage({
      id: reviewing.id,
      status: values.status,
      riskLevel: values.riskLevel,
      reason: values.reason,
      tags: String(values.tags || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    });
    message.success('审查结果已提交');
    setReviewVisible(false);
    setReviewing(null);
    await reload();
  };

  const columns: ColumnsType<MessageItem> = useMemo(
    () => [
      {
        title: '消息ID',
        dataIndex: 'id',
        width: 210,
        ellipsis: true,
      },
      {
        title: '类型',
        dataIndex: 'type',
        width: 100,
      },
      {
        title: '发送者',
        dataIndex: 'senderUid',
        width: 100,
      },
      {
        title: '目标',
        width: 180,
        render: (_, record) => `${record.targetType}:${record.targetUid}`,
      },
      {
        title: '预览',
        dataIndex: 'preview',
        ellipsis: true,
      },
      {
        title: '审查状态',
        dataIndex: 'reviewStatus',
        width: 120,
        render: (value: MessageReviewStatus | undefined) => (
          <Tag color={statusColor[value || 'unreviewed']}>{value || 'unreviewed'}</Tag>
        ),
      },
      {
        title: '风险',
        dataIndex: 'riskLevel',
        width: 100,
        render: (value: RiskLevel | undefined) => (
          <Tag color={riskColor[value || 'low']}>{value || 'low'}</Tag>
        ),
      },
      {
        title: '时间',
        dataIndex: 'createdAt',
        width: 180,
      },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 250,
        render: (_, record) => (
          <Space size="small" wrap>
            <Button size="small" onClick={() => void openDetail(record.id)}>
              详情
            </Button>
            <Button size="small" onClick={() => openReview(record)}>
              审查
            </Button>
            <Popconfirm
              title="确认删除该消息?"
              onConfirm={async () => {
                await deleteMessageAsAdmin({
                  id: record.id,
                  reason: 'Deleted by admin UI',
                });
                message.success('消息已删除');
                await reload();
              }}
            >
              <Button size="small" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [message, reload],
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
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="消息总量" value={summary?.messages?.total || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="24h新增" value={summary?.messages?.inWindow || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="已审查" value={summary?.reviews?.totalReviewed || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="高风险审查" value={summary?.reviews?.byRisk?.high || 0} /></Card>
        </Col>
      </Row>

      <Card style={{ marginTop: 16 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search
            allowClear
            placeholder="搜索消息ID/内容/UID"
            style={{ width: 280 }}
            onSearch={(value) => setQuery((prev) => ({ ...prev, q: value.trim(), page: 1 }))}
          />
          <Select
            value={query.type}
            style={{ width: 130 }}
            onChange={(value) => setQuery((prev) => ({ ...prev, type: value, page: 1 }))}
            options={[
              { label: '全部类型', value: 'all' },
              { label: 'text', value: 'text' },
              { label: 'image', value: 'image' },
              { label: 'file', value: 'file' },
              { label: 'voice', value: 'voice' },
            ]}
          />
          <Select
            value={query.targetType}
            style={{ width: 130 }}
            onChange={(value) => setQuery((prev) => ({ ...prev, targetType: value, page: 1 }))}
            options={[
              { label: '全部会话', value: 'all' },
              { label: 'private', value: 'private' },
              { label: 'group', value: 'group' },
            ]}
          />
          <Select
            value={query.reviewStatus}
            style={{ width: 150 }}
            onChange={(value) => setQuery((prev) => ({ ...prev, reviewStatus: value, page: 1 }))}
            options={[
              { label: '全部审查状态', value: 'all' },
              { label: 'unreviewed', value: 'unreviewed' },
              { label: 'approved', value: 'approved' },
              { label: 'flagged', value: 'flagged' },
              { label: 'blocked', value: 'blocked' },
              { label: 'deleted', value: 'deleted' },
            ]}
          />
          <Select
            value={query.riskLevel}
            style={{ width: 130 }}
            onChange={(value) => setQuery((prev) => ({ ...prev, riskLevel: value, page: 1 }))}
            options={[
              { label: '全部风险', value: 'all' },
              { label: 'low', value: 'low' },
              { label: 'medium', value: 'medium' },
              { label: 'high', value: 'high' },
            ]}
          />
        </Space>

        <Table<MessageItem>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1600 }}
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
        title={detail ? `消息详情 ${detail.id}` : '消息详情'}
        width={700}
        destroyOnHidden
      >
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="消息ID">{detail?.id || '-'}</Descriptions.Item>
          <Descriptions.Item label="发送者">{detail?.senderUid || '-'}</Descriptions.Item>
          <Descriptions.Item label="目标">{detail ? `${detail.targetType}:${detail.targetUid}` : '-'}</Descriptions.Item>
          <Descriptions.Item label="类型">{detail?.type || '-'}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{detail?.createdAt || '-'}</Descriptions.Item>
          <Descriptions.Item label="审查状态">
            <Tag color={statusColor[detail?.reviewStatus || 'unreviewed']}>{detail?.reviewStatus || 'unreviewed'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="风险等级">
            <Tag color={riskColor[detail?.riskLevel || 'low']}>{detail?.riskLevel || 'low'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="命中规则">
            {(detail?.inspection?.hitRules || []).map((rule) => (
              <Tag key={`${rule.id}-${rule.label}`} color="orange">{rule.label}</Tag>
            ))}
          </Descriptions.Item>
          <Descriptions.Item label="消息体JSON">
            <pre style={{ maxHeight: 280, overflow: 'auto', margin: 0 }}>
              {JSON.stringify(detail?.data || {}, null, 2)}
            </pre>
          </Descriptions.Item>
        </Descriptions>
        {detailLoading ? <div style={{ marginTop: 12 }}>加载中...</div> : null}
      </Drawer>

      <Modal
        open={reviewVisible}
        title={reviewing ? `审查消息 ${reviewing.id}` : '审查消息'}
        onCancel={() => {
          setReviewVisible(false);
          setReviewing(null);
        }}
        onOk={() => {
          void submitReview();
        }}
        destroyOnHidden
      >
        <Form form={reviewForm} layout="vertical">
          <Form.Item name="status" label="审查状态" rules={[{ required: true, message: '请选择状态' }]}> 
            <Select
              options={[
                { label: 'approved', value: 'approved' },
                { label: 'flagged', value: 'flagged' },
                { label: 'blocked', value: 'blocked' },
                { label: 'deleted', value: 'deleted' },
              ]}
            />
          </Form.Item>
          <Form.Item name="riskLevel" label="风险等级" rules={[{ required: true, message: '请选择风险等级' }]}> 
            <Select
              options={[
                { label: 'low', value: 'low' },
                { label: 'medium', value: 'medium' },
                { label: 'high', value: 'high' },
              ]}
            />
          </Form.Item>
          <Form.Item name="reason" label="原因">
            <Input.TextArea rows={3} maxLength={300} showCount />
          </Form.Item>
          <Form.Item name="tags" label="标签（逗号分隔）">
            <Input maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
};

export default MessagesReview;
