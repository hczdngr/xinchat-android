import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Phase4Overview } from '@/services/admin/api';
import { fetchPhase4Overview } from '@/services/admin/api';

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: string }).message || '请求失败');
  }
  return '请求失败';
};

const Phase4: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [overview, setOverview] = useState<Phase4Overview | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchPhase4Overview();
      setOverview(response.data || null);
      setErrorText('');
    } catch (error) {
      setErrorText(toErrorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const requestRows = useMemo(
    () => [
      { key: 'summaryRead', label: 'GET /api/summary', value: overview?.requestVolume?.summaryRead || 0 },
      {
        key: 'summaryRefresh',
        label: 'POST /api/summary/refresh',
        value: overview?.requestVolume?.summaryRefresh || 0,
      },
      {
        key: 'summaryArchive',
        label: 'POST /api/summary/archive',
        value: overview?.requestVolume?.summaryArchive || 0,
      },
      {
        key: 'chatOverview',
        label: 'POST /api/chat/overview',
        value: overview?.requestVolume?.chatOverview || 0,
      },
    ],
    [overview],
  );

  const responseRows = useMemo(
    () => [
      {
        key: 'summaryRead',
        path: '/api/summary',
        total: overview?.responses?.summaryRead?.total || 0,
        byStatus: overview?.responses?.summaryRead?.byStatus || {},
      },
      {
        key: 'summaryRefresh',
        path: '/api/summary/refresh',
        total: overview?.responses?.summaryRefresh?.total || 0,
        byStatus: overview?.responses?.summaryRefresh?.byStatus || {},
      },
      {
        key: 'summaryArchive',
        path: '/api/summary/archive',
        total: overview?.responses?.summaryArchive?.total || 0,
        byStatus: overview?.responses?.summaryArchive?.byStatus || {},
      },
      {
        key: 'chatOverview',
        path: '/api/chat/overview',
        total: overview?.responses?.chatOverview?.total || 0,
        byStatus: overview?.responses?.chatOverview?.byStatus || {},
      },
    ],
    [overview],
  );

  const topUsersColumns: ColumnsType<Phase4Overview['summary']['topUsers'][number]> = useMemo(
    () => [
      { title: 'UID', dataIndex: 'uid', width: 100 },
      { title: '未读总量', dataIndex: 'unreadTotal', width: 110 },
      { title: '未读会话', dataIndex: 'unreadConversations', width: 110 },
      { title: '待回复', dataIndex: 'todoCount', width: 100 },
      { title: '生成总数', dataIndex: 'generatedTotal', width: 110 },
      { title: '手动刷新', dataIndex: 'manualRefreshTotal', width: 110 },
      { title: '归档次数', dataIndex: 'archivedTotal', width: 110 },
      {
        title: '最近生成',
        width: 180,
        render: (_, record) =>
          record.latestGeneratedAt ? dayjs(record.latestGeneratedAt).format('YYYY-MM-DD HH:mm:ss') : '-',
      },
      {
        title: '最后错误',
        render: (_, record) => record.lastError || '-',
      },
    ],
    [],
  );

  return (
    <PageContainer
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>
          刷新
        </Button>,
      ]}
    >
      {errorText ? <Alert type="warning" message={errorText} showIcon style={{ marginBottom: 16 }} /> : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="功能开关" value={overview?.featureEnabled?.summaryCenter ? 'ON' : 'OFF'} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="有最新摘要用户" value={overview?.summary?.totals?.usersWithLatest || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="最新未读总量" value={overview?.summary?.totals?.unreadLatest || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="历史记录总量" value={overview?.summary?.totals?.historyRecords || 0} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="请求量（Phase4）" size="small">
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={requestRows}
              columns={[
                { title: '接口', dataIndex: 'label' },
                { title: '请求数', dataIndex: 'value', width: 120 },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="响应分布" size="small">
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={responseRows}
              columns={[
                { title: '接口', dataIndex: 'path' },
                { title: '总响应', dataIndex: 'total', width: 110 },
                {
                  title: '状态分布',
                  render: (_, record) =>
                    Object.entries(record.byStatus || {}).length > 0 ? (
                      <>
                        {Object.entries(record.byStatus || {}).map(([status, count]) => (
                          <Tag key={`${record.key}-${status}`}>
                            {status}: {Number(count) || 0}
                          </Tag>
                        ))}
                      </>
                    ) : (
                      '-'
                    ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="运行时状态" size="small">
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Statistic title="自动任务运行中" value={overview?.summary?.runtime?.running ? 'YES' : 'NO'} />
              </Col>
              <Col span={12}>
                <Statistic title="累计自动轮询" value={overview?.summary?.runtime?.totalRuns || 0} />
              </Col>
              <Col span={12}>
                <Statistic title="累计生成摘要" value={overview?.summary?.runtime?.totalGenerated || 0} />
              </Col>
              <Col span={12}>
                <Statistic title="累计推送次数" value={overview?.summary?.runtime?.totalPushes || 0} />
              </Col>
              <Col span={12}>
                <Statistic title="推送失败次数" value={overview?.summary?.runtime?.totalPushErrors || 0} />
              </Col>
              <Col span={12}>
                <Statistic title="自动间隔(ms)" value={overview?.summary?.runtime?.autoIntervalMs || 0} />
              </Col>
            </Row>
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              最近运行: {overview?.summary?.runtime?.lastRunAt || '-'}；最近跳过原因:{' '}
              {overview?.summary?.runtime?.lastSkippedReason || '-'}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              最后错误: {overview?.summary?.runtime?.lastError || '-'}
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="特性状态" size="small">
            <SpaceWrapLine
              items={[
                {
                  label: 'summaryCenter',
                  enabled: Boolean(overview?.featureEnabled?.summaryCenter),
                },
                {
                  label: 'summaryRuntime.featureEnabled',
                  enabled: Boolean(overview?.summary?.featureEnabled),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card title="Top 用户摘要负载" size="small" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey={(record) => String(record.uid)}
          pagination={false}
          dataSource={overview?.summary?.topUsers || []}
          columns={topUsersColumns}
          scroll={{ x: 980, y: 320 }}
        />
      </Card>
    </PageContainer>
  );
};

const SpaceWrapLine: React.FC<{ items: Array<{ label: string; enabled: boolean }> }> = ({ items }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    {items.map((item) => (
      <Tag key={item.label} color={item.enabled ? 'green' : 'red'}>
        {item.label}: {item.enabled ? 'ON' : 'OFF'}
      </Tag>
    ))}
  </div>
);

export default Phase4;
