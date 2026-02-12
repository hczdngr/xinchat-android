import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Statistic, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessagesSummary, RiskOverview } from '@/services/admin/api';
import { fetchMessagesSummary, fetchRiskOverview } from '@/services/admin/api';

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: string }).message || '请求失败');
  }
  return '请求失败';
};

const pickRecordText = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '-';
};

const Phase2: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [riskOverview, setRiskOverview] = useState<RiskOverview | null>(null);
  const [messagesSummary, setMessagesSummary] = useState<MessagesSummary | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [riskResp, messageResp] = await Promise.all([
        fetchRiskOverview(200),
        fetchMessagesSummary(24),
      ]);
      setRiskOverview(riskResp.data || null);
      setMessagesSummary(messageResp.data || null);
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

  const byLevelRows = useMemo(
    () =>
      Object.entries(riskOverview?.counts?.byLevel || {}).map(([level, count]) => ({
        level,
        count,
      })),
    [riskOverview],
  );

  const byTagRows = useMemo(
    () =>
      Object.entries(riskOverview?.counts?.byTag || {})
        .map(([tag, count]) => ({ tag, count: Number(count) || 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 40),
    [riskOverview],
  );

  const reviewRows = useMemo(
    () =>
      Object.entries(messagesSummary?.reviews?.byStatus || {}).map(([status, count]) => ({
        status,
        count,
      })),
    [messagesSummary],
  );

  const decisionColumns: ColumnsType<Record<string, unknown>> = useMemo(
    () => [
      {
        title: '时间',
        width: 180,
        render: (_, record) => pickRecordText(record, ['createdAt', 'timestamp', 'updatedAt']),
      },
      {
        title: '等级',
        width: 110,
        render: (_, record) => {
          const level = pickRecordText(record, ['level', 'riskLevel']);
          const color = level === 'high' ? 'red' : level === 'medium' ? 'orange' : 'blue';
          return <Tag color={color}>{level}</Tag>;
        },
      },
      {
        title: '标签',
        width: 220,
        render: (_, record) => {
          const tags = Array.isArray(record.tags)
            ? record.tags.map((item) => String(item)).slice(0, 4)
            : [];
          if (!tags.length) return '-';
          return (
            <>
              {tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </>
          );
        },
      },
      {
        title: '证据摘要',
        render: (_, record) => pickRecordText(record, ['summary', 'reason', 'evidenceSummary']),
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
            <Statistic title="风险决策" value={riskOverview?.counts?.decisions || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="风险申诉" value={riskOverview?.counts?.appeals || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="忽略次数" value={riskOverview?.counts?.ignored || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="24h消息总量" value={messagesSummary?.messages?.inWindow || 0} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="风险等级分布" size="small">
            <Table
              size="small"
              rowKey="level"
              pagination={false}
              dataSource={byLevelRows}
              columns={[
                {
                  title: '等级',
                  dataIndex: 'level',
                  render: (level: string) => {
                    const color = level === 'high' ? 'red' : level === 'medium' ? 'orange' : 'blue';
                    return <Tag color={color}>{level}</Tag>;
                  },
                },
                { title: '数量', dataIndex: 'count', width: 120 },
              ]}
            />
          </Card>

          <Card title="消息审查状态" size="small" style={{ marginTop: 12 }}>
            <Table
              size="small"
              rowKey="status"
              pagination={false}
              dataSource={reviewRows}
              columns={[
                { title: '状态', dataIndex: 'status' },
                { title: '数量', dataIndex: 'count', width: 120 },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card title="风险标签 Top" size="small">
            <Table
              size="small"
              rowKey="tag"
              pagination={false}
              dataSource={byTagRows}
              columns={[
                { title: '标签', dataIndex: 'tag' },
                { title: '命中次数', dataIndex: 'count', width: 140 },
              ]}
              scroll={{ y: 320 }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="最近风险命中证据" size="small" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey={(_, index) => String(index)}
          pagination={false}
          dataSource={Array.isArray(riskOverview?.recentDecisions) ? riskOverview?.recentDecisions : []}
          columns={decisionColumns}
          scroll={{ x: 860, y: 280 }}
        />
      </Card>

      <Card title="最近误报申诉" size="small" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey={(_, index) => String(index)}
          pagination={false}
          dataSource={Array.isArray(riskOverview?.recentAppeals) ? riskOverview?.recentAppeals : []}
          columns={decisionColumns}
          scroll={{ x: 860, y: 240 }}
        />
      </Card>
    </PageContainer>
  );
};

export default Phase2;
