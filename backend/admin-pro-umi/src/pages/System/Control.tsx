import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdminMetricsSnapshot,
  BottlenecksSnapshot,
  EventSummary,
  FeatureFlagsSnapshot,
  RiskOverview,
} from '@/services/admin/api';
import {
  fetchAdminMetrics,
  fetchBottlenecks,
  fetchEventsSummary,
  fetchFeatureFlags,
  fetchRiskOverview,
} from '@/services/admin/api';

const SystemControl: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  const [metrics, setMetrics] = useState<AdminMetricsSnapshot | null>(null);
  const [bottlenecks, setBottlenecks] = useState<BottlenecksSnapshot | null>(null);
  const [flags, setFlags] = useState<FeatureFlagsSnapshot | null>(null);
  const [events, setEvents] = useState<EventSummary | null>(null);
  const [risk, setRisk] = useState<RiskOverview | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [
        metricsResp,
        bottlenecksResp,
        flagsResp,
        eventsResp,
        riskResp,
      ] = await Promise.all([
        fetchAdminMetrics(),
        fetchBottlenecks(),
        fetchFeatureFlags(),
        fetchEventsSummary(),
        fetchRiskOverview(200),
      ]);
      setMetrics(metricsResp.data || null);
      setBottlenecks(bottlenecksResp.data || null);
      setFlags(flagsResp.data || null);
      setEvents(eventsResp.data || null);
      setRisk(riskResp.data || null);
      setErrorText('');
    } catch (error) {
      const text =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      setErrorText(text || '系统数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const flagColumns: ColumnsType<FeatureFlagsSnapshot['definitions'][number]> = useMemo(
    () => [
      { title: 'Feature', dataIndex: 'name', width: 220 },
      { title: 'ENV', dataIndex: 'env', width: 260 },
      {
        title: '默认值',
        dataIndex: 'defaultValue',
        width: 110,
        render: (value: boolean) => <Tag color={value ? 'blue' : 'default'}>{String(value)}</Tag>,
      },
      {
        title: '当前状态',
        dataIndex: 'enabled',
        width: 110,
        render: (value: boolean) => <Tag color={value ? 'green' : 'red'}>{value ? 'ON' : 'OFF'}</Tag>,
      },
    ],
    [],
  );

  const endpointColumns: ColumnsType<{ key: string; value: number }> = useMemo(
    () => [
      { title: 'Name', dataIndex: 'key' },
      { title: 'Value', dataIndex: 'value', width: 140 },
    ],
    [],
  );

  const countersTop = (metrics?.metrics?.counters || [])
    .slice()
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
    .slice(0, 12)
    .map((item) => ({ key: item.name, value: Number(item.value || 0) }));

  const gaugesTop = (metrics?.metrics?.gauges || [])
    .slice()
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
    .slice(0, 12)
    .map((item) => ({ key: item.name, value: Number(item.value || 0) }));

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
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="进程PID" value={metrics?.process?.pid || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="运行时长(秒)" value={Math.floor((metrics?.uptimeMs || 0) / 1000)} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="风险决策" value={risk?.counts?.decisions || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="风险申诉" value={risk?.counts?.appeals || 0} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="Feature Flags" size="small">
            <Table
              size="small"
              rowKey="name"
              columns={flagColumns}
              dataSource={flags?.definitions || []}
              pagination={false}
              scroll={{ y: 320 }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="系统建议（瓶颈）" size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
              {(bottlenecks?.recommendations || []).map((item, index) => (
                <Alert key={`${item}-${index}`} type="info" showIcon message={item} />
              ))}
              {!bottlenecks?.recommendations?.length ? (
                <Typography.Text type="secondary">暂无建议</Typography.Text>
              ) : null}
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="Top Counters" size="small">
            <Table
              size="small"
              rowKey="key"
              columns={endpointColumns}
              dataSource={countersTop}
              pagination={false}
              scroll={{ y: 300 }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="Top Gauges" size="small">
            <Table
              size="small"
              rowKey="key"
              columns={endpointColumns}
              dataSource={gaugesTop}
              pagination={false}
              scroll={{ y: 300 }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col span={24}>
          <Card title="事件日志统计（events/summary）" size="small">
            <pre style={{ maxHeight: 340, overflow: 'auto', margin: 0 }}>
              {JSON.stringify(events?.logger || {}, null, 2)}
            </pre>
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};

export default SystemControl;
