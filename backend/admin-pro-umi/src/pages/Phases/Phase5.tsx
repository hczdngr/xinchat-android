import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  App,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Phase5Overview } from '@/services/admin/api';
import { fetchPhase5Overview, updateFeatureFlag, updateRecoConfig } from '@/services/admin/api';

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: string }).message || '请求失败');
  }
  return '请求失败';
};

const readNumber = (source: Record<string, unknown>, key: string, fallback = 0): number => {
  const value = Number(source?.[key]);
  return Number.isFinite(value) ? value : fallback;
};

const readBoolean = (source: Record<string, unknown>, key: string, fallback = false): boolean => {
  if (typeof source?.[key] === 'boolean') return Boolean(source[key]);
  return fallback;
};

const Phase5: React.FC = () => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [overview, setOverview] = useState<Phase5Overview | null>(null);
  const [form] = Form.useForm();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchPhase5Overview();
      const data = response.data || null;
      setOverview(data);
      const config = ((data?.reco?.config || {}) as Record<string, unknown>) || {};
      form.setFieldsValue({
        rolloutPercent: readNumber(config, 'rolloutPercent', 10),
        epsilon: readNumber(config, 'epsilon', 0.1),
        learningRate: readNumber(config, 'learningRate', 0.08),
        minCandidates: readNumber(config, 'minCandidates', 2),
        maxCandidates: readNumber(config, 'maxCandidates', 60),
        onlineUpdate: readBoolean(config, 'onlineUpdate', true),
      });
      setErrorText('');
    } catch (error) {
      setErrorText(toErrorText(error));
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleFlag = async (name: string, enabled: boolean) => {
    setSaving(true);
    try {
      await updateFeatureFlag({ name, enabled });
      message.success(`${name} => ${enabled ? 'ON' : 'OFF'}`);
      await reload();
    } catch (error) {
      message.error(toErrorText(error));
    } finally {
      setSaving(false);
    }
  };

  const submitConfig = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await updateRecoConfig({
        rolloutPercent: Number(values.rolloutPercent),
        epsilon: Number(values.epsilon),
        learningRate: Number(values.learningRate),
        minCandidates: Number(values.minCandidates),
        maxCandidates: Number(values.maxCandidates),
        onlineUpdate: Boolean(values.onlineUpdate),
      });
      message.success('Reco 配置已更新');
      await reload();
    } catch (error) {
      message.error(toErrorText(error));
    } finally {
      setSaving(false);
    }
  };

  const decisionColumns: ColumnsType<Record<string, unknown>> = useMemo(
    () => [
      { title: '时间', dataIndex: 'createdAt', width: 190 },
      { title: 'UID', dataIndex: 'uid', width: 90 },
      {
        title: '模式',
        dataIndex: 'mode',
        width: 110,
        render: (value: string) => <Tag>{String(value || '-')}</Tag>,
      },
      { title: '命中候选', dataIndex: 'selectedCandidateId', width: 180 },
      {
        title: 'Provider',
        dataIndex: 'provider',
        width: 110,
      },
      {
        title: '探索',
        render: (_, record) => (record?.metadata && (record.metadata as Record<string, unknown>)?.explored ? 'yes' : 'no'),
      },
    ],
    [],
  );

  const feedbackColumns: ColumnsType<Record<string, unknown>> = useMemo(
    () => [
      { title: '时间', dataIndex: 'createdAt', width: 190 },
      { title: 'UID', dataIndex: 'uid', width: 90 },
      { title: '动作', dataIndex: 'action', width: 120 },
      { title: 'reward', dataIndex: 'reward', width: 100 },
      { title: 'decisionId', dataIndex: 'decisionId', width: 220 },
      { title: 'candidateId', dataIndex: 'candidateId', width: 180 },
    ],
    [],
  );

  const profileColumns: ColumnsType<Record<string, unknown>> = useMemo(
    () => [
      { title: 'UID', dataIndex: 'uid', width: 90 },
      {
        title: '交互统计',
        render: (_, record) => {
          const interactions = (record?.interactions || {}) as Record<string, unknown>;
          return `T:${Number(interactions?.total || 0)} / +${Number(interactions?.positive || 0)} / -${Number(
            interactions?.negative || 0,
          )}`;
        },
      },
      {
        title: 'Top Tags',
        render: (_, record) => {
          const tags = Array.isArray(record?.topTags) ? record.topTags : [];
          if (!tags.length) return '-';
          return tags
            .slice(0, 5)
            .map((item) => {
              const payload = item as Record<string, unknown>;
              return `${String(payload.name || '')}(${Number(payload.weight || 0).toFixed(2)})`;
            })
            .join(', ');
        },
      },
      {
        title: '更新时间',
        dataIndex: 'updatedAt',
        width: 190,
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
          <Card><Statistic title="Decision(24h)" value={overview?.reco?.counts?.decisions || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="Feedback(24h)" value={overview?.reco?.counts?.feedbacks || 0} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="CTR" value={(overview?.reco?.online?.ctr || 0) * 100} precision={2} suffix="%" /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="Reply Rate" value={(overview?.reco?.online?.replyRate || 0) * 100} precision={2} suffix="%" /></Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="Phase5 开关（在线）" size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Row justify="space-between" align="middle">
                <Typography.Text>recoVw</Typography.Text>
                <Switch
                  loading={saving}
                  checked={Boolean(overview?.featureEnabled?.recoVw)}
                  onChange={(checked) => void toggleFlag('recoVw', checked)}
                />
              </Row>
              <Row justify="space-between" align="middle">
                <Typography.Text>recoVwShadow</Typography.Text>
                <Switch
                  loading={saving}
                  checked={Boolean(overview?.featureEnabled?.recoVwShadow)}
                  onChange={(checked) => void toggleFlag('recoVwShadow', checked)}
                />
              </Row>
              <Row justify="space-between" align="middle">
                <Typography.Text>recoVwOnline</Typography.Text>
                <Switch
                  loading={saving}
                  checked={Boolean(overview?.featureEnabled?.recoVwOnline)}
                  onChange={(checked) => void toggleFlag('recoVwOnline', checked)}
                />
              </Row>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
              vw ready:{' '}
              {Boolean((overview?.reco?.vwStatus as Record<string, unknown> | undefined)?.ready)
                ? 'YES'
                : 'NO'}
            </Typography.Paragraph>
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card title="灰度与在线学习参数" size="small" extra={<Button type="primary" loading={saving} onClick={() => void submitConfig()}>保存</Button>}>
            <Form form={form} layout="vertical">
              <Row gutter={[12, 0]}>
                <Col span={12}>
                  <Form.Item label="rolloutPercent" name="rolloutPercent" rules={[{ required: true }]}>
                    <InputNumber min={0} max={100} precision={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="epsilon" name="epsilon" rules={[{ required: true }]}>
                    <InputNumber min={0} max={0.8} step={0.01} precision={3} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="learningRate" name="learningRate" rules={[{ required: true }]}>
                    <InputNumber min={0.001} max={0.5} step={0.001} precision={4} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="onlineUpdate" name="onlineUpdate" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="minCandidates" name="minCandidates" rules={[{ required: true }]}>
                    <InputNumber min={1} max={100} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="maxCandidates" name="maxCandidates" rules={[{ required: true }]}>
                    <InputNumber min={1} max={300} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
        <Col xs={24} xl={12}>
          <Card title="离线评估（IPS/DR）" size="small">
            <Row gutter={[12, 12]}>
              <Col span={12}><Statistic title="samples" value={overview?.reco?.offline?.samples || 0} /></Col>
              <Col span={12}><Statistic title="avgReward" value={overview?.reco?.offline?.avgReward || 0} precision={4} /></Col>
              <Col span={12}><Statistic title="IPS" value={overview?.reco?.offline?.ips || 0} precision={4} /></Col>
              <Col span={12}><Statistic title="DR" value={overview?.reco?.offline?.dr || 0} precision={4} /></Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="请求量（24h）" size="small">
            <Row gutter={[12, 12]}>
              <Col span={12}><Statistic title="/api/reco/decision" value={overview?.requestVolume?.recoDecision || 0} /></Col>
              <Col span={12}><Statistic title="/api/reco/feedback" value={overview?.requestVolume?.recoFeedback || 0} /></Col>
              <Col span={12}><Statistic title="/api/reco/admin" value={overview?.requestVolume?.recoAdmin || 0} /></Col>
              <Col span={12}><Statistic title="/api/chat/overview" value={overview?.requestVolume?.chatOverview || 0} /></Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Card title="最近决策日志" size="small" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey={(record) => String(record.id || `${record.uid}-${record.createdAt}`)}
          pagination={{ pageSize: 8 }}
          columns={decisionColumns}
          dataSource={overview?.reco?.recentDecisions || []}
          scroll={{ x: 920 }}
        />
      </Card>

      <Card title="最近反馈日志" size="small" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey={(record) => String(record.id || `${record.uid}-${record.createdAt}`)}
          pagination={{ pageSize: 8 }}
          columns={feedbackColumns}
          dataSource={overview?.reco?.recentFeedbacks || []}
          scroll={{ x: 980 }}
        />
      </Card>

      <Card title="用户个性化画像（VW）" size="small" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey={(record) => `${String(record.uid || '')}-${String(record.updatedAt || '')}`}
          pagination={{ pageSize: 8 }}
          columns={profileColumns}
          dataSource={overview?.reco?.userProfiles || []}
          scroll={{ x: 900 }}
        />
      </Card>
    </PageContainer>
  );
};

export default Phase5;
