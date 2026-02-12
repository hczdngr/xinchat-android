import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Statistic, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Phase1Overview } from '@/services/admin/api';
import { fetchPhase1Overview } from '@/services/admin/api';

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: string }).message || '请求失败');
  }
  return '请求失败';
};

const toDistRows = (input: Record<string, number> | undefined) =>
  Object.entries(input || {}).map(([key, value]) => ({ key, value }));

const Phase1: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [overview, setOverview] = useState<Phase1Overview | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchPhase1Overview();
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

  const distColumns: ColumnsType<{ key: string; value: number }> = useMemo(
    () => [
      { title: '类别', dataIndex: 'key' },
      { title: '人数', dataIndex: 'value', width: 120 },
    ],
    [],
  );

  const sampleColumns: ColumnsType<Phase1Overview['samples'][number]> = useMemo(
    () => [
      { title: 'UID', dataIndex: 'uid', width: 110 },
      { title: '用户名', dataIndex: 'username', width: 180, ellipsis: true },
      { title: '昵称', dataIndex: 'nickname', width: 180, ellipsis: true },
      {
        title: '回复风格',
        width: 120,
        render: (_, record) => <Tag>{record.profile.replyStyle}</Tag>,
      },
      {
        title: '翻译风格',
        width: 120,
        render: (_, record) => <Tag>{record.profile.translateStyle}</Tag>,
      },
      {
        title: '解释级别',
        width: 120,
        render: (_, record) => <Tag>{record.profile.explanationLevel}</Tag>,
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
            <Statistic title="用户总数" value={overview?.users?.total || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="自定义偏好用户" value={overview?.users?.customizedUsers || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="回复建议请求" value={overview?.requestVolume?.replySuggest || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="翻译请求" value={overview?.requestVolume?.translate || 0} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="功能开关" size="small">
            <Tag color={overview?.featureEnabled?.replyAssistant ? 'green' : 'red'}>
              回复助手 {overview?.featureEnabled?.replyAssistant ? 'ON' : 'OFF'}
            </Tag>
            <Tag color={overview?.featureEnabled?.translate ? 'green' : 'red'}>
              翻译服务 {overview?.featureEnabled?.translate ? 'ON' : 'OFF'}
            </Tag>
            <Tag color={overview?.featureEnabled?.translatePersonalization ? 'green' : 'red'}>
              翻译个性化 {overview?.featureEnabled?.translatePersonalization ? 'ON' : 'OFF'}
            </Tag>
          </Card>

          <Card title="回复风格分布" size="small" style={{ marginTop: 12 }}>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={toDistRows(overview?.users?.byReplyStyle)}
              columns={distColumns}
            />
          </Card>

          <Card title="翻译风格分布" size="small" style={{ marginTop: 12 }}>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={toDistRows(overview?.users?.byTranslateStyle)}
              columns={distColumns}
            />
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card title="解释级别分布" size="small">
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={toDistRows(overview?.users?.byExplanationLevel)}
              columns={distColumns}
            />
          </Card>

          <Card title="用户个性化标签 Top" size="small" style={{ marginTop: 12 }}>
            <Table
              size="small"
              rowKey="name"
              pagination={false}
              dataSource={overview?.topTags || []}
              columns={[
                { title: '标签', dataIndex: 'name' },
                { title: '命中用户数', dataIndex: 'count', width: 140 },
              ]}
              scroll={{ y: 280 }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="个性化用户样本" size="small" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey="uid"
          pagination={false}
          dataSource={overview?.samples || []}
          columns={sampleColumns}
          scroll={{ x: 900, y: 300 }}
        />
      </Card>
    </PageContainer>
  );
};

export default Phase1;
