import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, App, Button, Card, Col, Row, Statistic, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdminMetricsSnapshot,
  BottlenecksSnapshot,
  EventSummary,
  FeatureFlagsSnapshot,
} from '@/services/admin/api';
import {
  fetchAdminMetrics,
  fetchBottlenecks,
  fetchEventsSummary,
  fetchFeatureFlags,
  updateFeatureFlag,
} from '@/services/admin/api';

const REQUIRED_EVENT_TYPES = ['impression', 'click', 'reply', 'mute', 'report', 'risk_hit'];

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: string }).message || '请求失败');
  }
  return '请求失败';
};

const toEventTypeRows = (metrics: AdminMetricsSnapshot | null) => {
  const map = new Map<string, number>();
  (metrics?.metrics?.counters || [])
    .filter((entry) => entry.name === 'event_log_accepted_total')
    .forEach((entry) => {
      const eventType = String(entry?.labels?.eventType || 'unknown');
      map.set(eventType, (map.get(eventType) || 0) + (Number(entry.value) || 0));
    });
  return REQUIRED_EVENT_TYPES.map((eventType) => ({
    eventType,
    value: Number(map.get(eventType) || 0),
  }));
};

const pickCounter = (
  metrics: AdminMetricsSnapshot | null,
  name: string,
  predicate: (labels: Record<string, string>) => boolean = () => true,
) =>
  (metrics?.metrics?.counters || [])
    .filter((entry) => entry.name === name && predicate(entry.labels || {}))
    .reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);

const Phase0: React.FC = () => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState('');

  const [metrics, setMetrics] = useState<AdminMetricsSnapshot | null>(null);
  const [flags, setFlags] = useState<FeatureFlagsSnapshot | null>(null);
  const [events, setEvents] = useState<EventSummary | null>(null);
  const [bottlenecks, setBottlenecks] = useState<BottlenecksSnapshot | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [metricsResp, flagsResp, eventsResp, bottlenecksResp] = await Promise.all([
        fetchAdminMetrics(),
        fetchFeatureFlags(),
        fetchEventsSummary(),
        fetchBottlenecks(),
      ]);
      setMetrics(metricsResp.data || null);
      setFlags(flagsResp.data || null);
      setEvents(eventsResp.data || null);
      setBottlenecks(bottlenecksResp.data || null);
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

  const toggleFlag = useCallback(
    async (name: string, enabled: boolean) => {
      setSaving(true);
      try {
        await updateFeatureFlag({ name, enabled });
        message.success(`${name} -> ${enabled ? 'ON' : 'OFF'}`);
        await reload();
      } catch (error) {
        message.error(toErrorText(error));
      } finally {
        setSaving(false);
      }
    },
    [message, reload],
  );

  const flagColumns: ColumnsType<FeatureFlagsSnapshot['definitions'][number]> = useMemo(
    () => [
      {
        title: 'Feature',
        dataIndex: 'name',
      },
      {
        title: 'ENV',
        dataIndex: 'env',
      },
      {
        title: '默认值',
        dataIndex: 'defaultValue',
        width: 100,
        render: (value: boolean) => <Tag color={value ? 'blue' : 'default'}>{String(value)}</Tag>,
      },
      {
        title: '来源',
        dataIndex: 'source',
        width: 120,
        render: (value: string, record) => (
          <Tag color={record.override === null || typeof record.override === 'undefined' ? 'default' : 'gold'}>
            {value || '-'}
          </Tag>
        ),
      },
      {
        title: '当前状态(可改)',
        dataIndex: 'enabled',
        width: 160,
        render: (value: boolean, record) => (
          <Switch
            size="small"
            checked={value}
            loading={saving}
            onChange={(checked) => {
              void toggleFlag(record.name, checked);
            }}
          />
        ),
      },
    ],
    [saving, toggleFlag],
  );

  const eventTypeRows = toEventTypeRows(metrics);
  const acceptedTotal = pickCounter(metrics, 'event_log_accepted_total');
  const droppedRateLimited = pickCounter(metrics, 'event_log_rate_limited_total');
  const queueLength = Number((events?.logger as any)?.queueLength || 0);
  const httpRequests = pickCounter(metrics, 'http_requests_total');

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
            <Statistic title="事件累计写入" value={acceptedTotal} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="事件限流丢弃" value={droppedRateLimited} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="事件队列长度" value={queueLength} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="HTTP 请求总数" value={httpRequests} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="事件类型埋点（Phase0要求）" size="small">
            <Table
              size="small"
              rowKey="eventType"
              pagination={false}
              dataSource={eventTypeRows}
              columns={[
                { title: '事件类型', dataIndex: 'eventType' },
                { title: '累计次数', dataIndex: 'value', width: 140 },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card title="Feature 开关（可回滚）" size="small">
            <Table
              size="small"
              rowKey="name"
              pagination={false}
              dataSource={flags?.definitions || []}
              columns={flagColumns}
              scroll={{ y: 360 }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col span={24}>
          <Card title="瓶颈建议与降级观察" size="small">
            {(bottlenecks?.recommendations || []).length ? (
              (bottlenecks?.recommendations || []).map((item, index) => (
                <Alert key={`${item}-${index}`} type="info" showIcon message={item} style={{ marginBottom: 8 }} />
              ))
            ) : (
              <Typography.Text type="secondary">暂无建议</Typography.Text>
            )}
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};

export default Phase0;
