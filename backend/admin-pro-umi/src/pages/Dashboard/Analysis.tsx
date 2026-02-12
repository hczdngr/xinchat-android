import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Column, Pie } from '@ant-design/charts';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  InputNumber,
  Row,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import ForceGraph2D from 'react-force-graph-2d';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AdminMetricsSnapshot,
  BottlenecksSnapshot,
  MessagesSummary,
  RiskOverview,
  SocialOverview,
  SocialTree,
  SocialTreeEdge,
  SocialTreeNode,
  UsersSummary,
} from '@/services/admin/api';
import {
  fetchAdminMetrics,
  fetchBottlenecks,
  fetchMessagesSummary,
  fetchRiskOverview,
  fetchSocialOverview,
  fetchSocialTree,
  fetchUsersSummary,
} from '@/services/admin/api';

type ForceGraphNode = SocialTreeNode & {
  id: string;
  color: string;
  val: number;
  fx?: number;
  fy?: number;
  x?: number;
  y?: number;
};

type ForceGraphLink = SocialTreeEdge & {
  source: string;
  target: string;
  color: string;
};

const bytesToMb = (value: number | undefined): number =>
  Number((((Number(value) || 0) / 1024 / 1024)).toFixed(2));

const formatNumber = (value: number | undefined): string =>
  new Intl.NumberFormat('zh-CN').format(Number(value) || 0);

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: string }).message || '请求失败');
  }
  return '请求失败';
};

const isHidden = (): boolean =>
  typeof document !== 'undefined' ? document.hidden : false;

const useAdaptivePolling = (
  task: () => Promise<void>,
  options: { visibleMs: number; hiddenMs: number; maxMs?: number },
  deps: React.DependencyList,
) => {
  useEffect(() => {
    let stopped = false;
    let running = false;
    let failCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const maxMs = options.maxMs || 120_000;

    const schedule = (immediate = false) => {
      if (stopped) return;
      const base = isHidden() ? options.hiddenMs : options.visibleMs;
      const backoff = Math.min(6, failCount);
      const delay = immediate ? 0 : Math.min(maxMs, base * 2 ** backoff);
      timer = setTimeout(() => {
        void run();
      }, delay);
    };

    const run = async () => {
      if (stopped || running) {
        schedule();
        return;
      }
      running = true;
      try {
        await task();
        failCount = 0;
      } catch {
        failCount += 1;
      } finally {
        running = false;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (timer) clearTimeout(timer);
      schedule(true);
    };

    schedule(true);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, deps);
};

const Analysis: React.FC = () => {
  const [metrics, setMetrics] = useState<AdminMetricsSnapshot | null>(null);
  const [usersSummary, setUsersSummary] = useState<UsersSummary | null>(null);
  const [messagesSummary, setMessagesSummary] = useState<MessagesSummary | null>(null);
  const [riskOverview, setRiskOverview] = useState<RiskOverview | null>(null);
  const [socialOverview, setSocialOverview] = useState<SocialOverview | null>(null);
  const [bottlenecks, setBottlenecks] = useState<BottlenecksSnapshot | null>(null);

  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [treeDepth, setTreeDepth] = useState(2);
  const [includeGroups, setIncludeGroups] = useState(true);
  const [socialTree, setSocialTree] = useState<SocialTree | null>(null);

  const [loading, setLoading] = useState(true);
  const [treeLoading, setTreeLoading] = useState(true);
  const [globalError, setGlobalError] = useState('');
  const [treeError, setTreeError] = useState('');
  const [overviewUpdatedAt, setOverviewUpdatedAt] = useState('');
  const [treeUpdatedAt, setTreeUpdatedAt] = useState('');

  const graphWrapRef = useRef<HTMLDivElement | null>(null);
  const [graphSize, setGraphSize] = useState({ width: 900, height: 540 });

  const refreshOverview = useCallback(async () => {
    const responses = await Promise.allSettled([
      fetchAdminMetrics(),
      fetchUsersSummary(),
      fetchMessagesSummary(24),
      fetchRiskOverview(160),
      fetchSocialOverview(),
      fetchBottlenecks(),
    ]);

    const hasSuccess = responses.some((item) => item.status === 'fulfilled');
    if (!hasSuccess) {
      throw new Error('仪表盘数据全部获取失败');
    }

    if (responses[0].status === 'fulfilled') setMetrics(responses[0].value.data || null);
    if (responses[1].status === 'fulfilled') setUsersSummary(responses[1].value.data || null);
    if (responses[2].status === 'fulfilled') setMessagesSummary(responses[2].value.data || null);
    if (responses[3].status === 'fulfilled') setRiskOverview(responses[3].value.data || null);
    if (responses[4].status === 'fulfilled') {
      const nextOverview = responses[4].value.data || null;
      setSocialOverview(nextOverview);
      if (!selectedUid) {
        const defaultUid = Number(nextOverview?.topUsers?.[0]?.uid || 0);
        if (defaultUid > 0) setSelectedUid(defaultUid);
      }
    }
    if (responses[5].status === 'fulfilled') setBottlenecks(responses[5].value.data || null);

    setGlobalError('');
    setOverviewUpdatedAt(new Date().toISOString());
    setLoading(false);
  }, [selectedUid]);

  const refreshTree = useCallback(async () => {
    if (!selectedUid || selectedUid <= 0) return;
    const response = await fetchSocialTree({
      uid: selectedUid,
      depth: treeDepth,
      includeGroups,
    });
    setSocialTree(response?.data || null);
    setTreeError('');
    setTreeUpdatedAt(new Date().toISOString());
    setTreeLoading(false);
  }, [includeGroups, selectedUid, treeDepth]);

  useAdaptivePolling(
    async () => {
      try {
        await refreshOverview();
      } catch (error) {
        setGlobalError(toErrorText(error));
        setLoading(false);
      }
    },
    { visibleMs: 5000, hiddenMs: 20000, maxMs: 120000 },
    [refreshOverview],
  );

  useAdaptivePolling(
    async () => {
      try {
        await refreshTree();
      } catch (error) {
        setTreeError(toErrorText(error));
        setTreeLoading(false);
      }
    },
    { visibleMs: 12000, hiddenMs: 45000, maxMs: 120000 },
    [refreshTree],
  );

  useEffect(() => {
    setTreeLoading(true);
  }, [selectedUid, treeDepth, includeGroups]);

  useEffect(() => {
    if (!graphWrapRef.current || typeof ResizeObserver === 'undefined') return;
    const host = graphWrapRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.max(320, Math.floor(entry.contentRect.width));
      const height = Math.max(420, Math.floor(Math.min(760, width * 0.62)));
      setGraphSize((prev) => {
        if (prev.width === width && prev.height === height) return prev;
        return { width, height };
      });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const messageTypeData = useMemo(
    () =>
      Object.entries(messagesSummary?.messages?.byType || {}).map(([type, count]) => ({
        type,
        count,
      })),
    [messagesSummary],
  );

  const riskLevelData = useMemo(
    () =>
      Object.entries(riskOverview?.counts?.byLevel || {}).map(([level, count]) => ({
        level,
        count,
      })),
    [riskOverview],
  );

  const topUsers = socialOverview?.topUsers || [];
  const topGroups = socialOverview?.topGroups || [];

  const graphData = useMemo<{ nodes: ForceGraphNode[]; links: ForceGraphLink[] }>(() => {
    const nodes: ForceGraphNode[] = (socialTree?.nodes || []).map((node) => ({
      ...node,
      id: node.id,
      color:
        node.type === 'group'
          ? '#f59f00'
          : node.uid === selectedUid
            ? '#1677ff'
            : node.online
              ? '#52c41a'
              : '#8c8c8c',
      val:
        node.type === 'group'
          ? Math.max(5, Math.round((Number(node.memberCount) || 0) / 2))
          : Math.max(5, (Number(node.friendCount) || 0) + 4),
    }));
    const links: ForceGraphLink[] = (socialTree?.edges || []).map((edge) => ({
      ...edge,
      source: edge.from,
      target: edge.to,
      color: edge.type === 'group_member' ? 'rgba(245,159,0,0.45)' : 'rgba(22,119,255,0.5)',
    }));
    return { nodes, links };
  }, [selectedUid, socialTree]);

  const topUsersColumns: ColumnsType<(typeof topUsers)[number]> = [
    {
      title: 'UID',
      dataIndex: 'uid',
      width: 120,
    },
    {
      title: '昵称',
      dataIndex: 'nickname',
      ellipsis: true,
    },
    {
      title: '好友数',
      dataIndex: 'friendCount',
      width: 120,
      render: (value: number) => <Tag color={value > 20 ? 'blue' : 'default'}>{value}</Tag>,
    },
  ];

  return (
    <PageContainer
      content="自动轮询已启用：前台高频刷新，后台自动降频并失败退避，无需手动设置轮询时间。"
      extra={[
        <Button
          key="refresh"
          icon={<ReloadOutlined />}
          onClick={() => {
            void refreshOverview().catch((error) => setGlobalError(toErrorText(error)));
            void refreshTree().catch((error) => setTreeError(toErrorText(error)));
          }}
        >
          手动刷新
        </Button>,
      ]}
    >
      {globalError ? (
        <Alert
          type="warning"
          message={`部分数据刷新失败：${globalError}`}
          style={{ marginBottom: 16 }}
          showIcon
        />
      ) : null}
      {loading ? (
        <Spin style={{ width: '100%', marginTop: 48, marginBottom: 48 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <Card>
                <Statistic title="注册用户" value={usersSummary?.total || 0} />
                <Typography.Text type="secondary">
                  在线 {formatNumber(usersSummary?.online)} / 封禁 {formatNumber(usersSummary?.blocked)}
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card>
                <Statistic title="消息总量" value={messagesSummary?.messages?.total || 0} />
                <Typography.Text type="secondary">
                  近24小时 {formatNumber(messagesSummary?.messages?.inWindow)}
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card>
                <Statistic title="风险命中" value={riskOverview?.counts?.decisions || 0} />
                <Typography.Text type="secondary">
                  申诉 {formatNumber(riskOverview?.counts?.appeals)}
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card>
                <Statistic title="WS 在线连接" value={metrics?.ws?.activeSockets || 0} />
                <Typography.Text type="secondary">
                  活跃用户 {formatNumber(metrics?.ws?.activeUsers)}
                </Typography.Text>
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
            <Col xs={24} lg={12}>
              <Card title="消息类型分布" size="small">
                {messageTypeData.length ? (
                  <Column
                    data={messageTypeData}
                    xField="type"
                    yField="count"
                    colorField="type"
                    label={{ position: 'top' }}
                  />
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title="风险等级分布" size="small">
                {riskLevelData.length ? (
                  <Pie
                    data={riskLevelData}
                    angleField="count"
                    colorField="level"
                    label={{ text: 'count', position: 'outside' }}
                    legend={{ position: 'bottom' }}
                  />
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
            <Col xs={24} lg={14}>
              <Card title="社交网络总览" size="small">
                <Space size="large" wrap>
                  <Statistic
                    title="互相关系边"
                    value={socialOverview?.totals?.mutualFriendEdges || 0}
                  />
                  <Statistic
                    title="群组数量"
                    value={socialOverview?.totals?.groups || 0}
                  />
                  <Statistic
                    title="孤立用户"
                    value={socialOverview?.totals?.isolatedUsers || 0}
                  />
                  <Statistic
                    title="最大连通分量"
                    value={socialOverview?.metrics?.largestComponentSize || 0}
                  />
                </Space>
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card title="系统资源" size="small">
                <Space size="large" wrap>
                  <Statistic
                    title="堆内存(MB)"
                    value={bytesToMb(metrics?.process?.heapUsedBytes)}
                  />
                  <Statistic title="RSS(MB)" value={bytesToMb(metrics?.process?.rssBytes)} />
                </Space>
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
            <Col xs={24} lg={13}>
              <Card title="好友影响力排行" size="small">
                <Table
                  rowKey="uid"
                  size="small"
                  pagination={false}
                  columns={topUsersColumns}
                  dataSource={topUsers}
                />
              </Card>
            </Col>
            <Col xs={24} lg={11}>
              <Card title="群活跃规模" size="small">
                {topGroups.length ? (
                  <Column
                    data={topGroups.map((item) => ({ name: item.name, memberCount: item.memberCount }))}
                    xField="name"
                    yField="memberCount"
                    xAxis={{ label: { autoHide: true, autoRotate: false } }}
                    label={{ position: 'top' }}
                  />
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
            <Col span={24}>
              <Card
                title="个人社交树（力导图）"
                size="small"
                extra={
                  <Space wrap>
                    <Typography.Text type="secondary">根用户UID</Typography.Text>
                    <InputNumber
                      min={1}
                      max={2147483647}
                      value={selectedUid || undefined}
                      onChange={(value) => setSelectedUid(Number(value) > 0 ? Number(value) : null)}
                    />
                    <Typography.Text type="secondary">深度</Typography.Text>
                    <InputNumber
                      min={1}
                      max={4}
                      value={treeDepth}
                      onChange={(value) => setTreeDepth(Number(value) > 0 ? Number(value) : 2)}
                    />
                    <Typography.Text type="secondary">包含群节点</Typography.Text>
                    <Switch checked={includeGroups} onChange={setIncludeGroups} />
                  </Space>
                }
              >
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  交互说明：滚轮缩放，拖拽节点改变布局，右键节点可解除固定，点击用户节点可直接切换为新的根用户。
                </Typography.Paragraph>
                {treeError ? (
                  <Alert
                    type="warning"
                    message={`社交树刷新失败：${treeError}`}
                    style={{ marginBottom: 12 }}
                    showIcon
                  />
                ) : null}
                {treeLoading ? (
                  <Spin style={{ width: '100%', marginTop: 32, marginBottom: 32 }} />
                ) : socialTree && graphData.nodes.length > 0 ? (
                  <div ref={graphWrapRef} style={{ width: '100%' }}>
                    <ForceGraph2D
                      width={graphSize.width}
                      height={graphSize.height}
                      graphData={graphData}
                      backgroundColor="transparent"
                      nodeId="id"
                      nodeVal="val"
                      nodeColor={(node: unknown) => (node as ForceGraphNode).color}
                      linkColor={(link: unknown) => (link as ForceGraphLink).color}
                      linkWidth={(link: unknown) =>
                        (link as ForceGraphLink).type === 'friend' ? 1.8 : 1
                      }
                      nodeCanvasObjectMode={() => 'after'}
                      nodeCanvasObject={(
                        node: unknown,
                        ctx: CanvasRenderingContext2D,
                        globalScale: number,
                      ) => {
                        const safeNode = node as ForceGraphNode;
                        const label = String(safeNode.label || '');
                        if (!label) return;
                        const fontSize = Math.max(10, 12 / globalScale);
                        ctx.font = `${fontSize}px Sans-Serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'top';
                        ctx.fillStyle = safeNode.type === 'group' ? '#ad6800' : '#1f1f1f';
                        ctx.fillText(label, Number(safeNode.x) || 0, (Number(safeNode.y) || 0) + 8);
                      }}
                      onNodeDragEnd={(node: unknown) => {
                        const safeNode = node as ForceGraphNode;
                        safeNode.fx = safeNode.x;
                        safeNode.fy = safeNode.y;
                      }}
                      onNodeRightClick={(node: unknown) => {
                        const safeNode = node as ForceGraphNode;
                        safeNode.fx = undefined;
                        safeNode.fy = undefined;
                      }}
                      onNodeClick={(node: unknown) => {
                        const safeNode = node as ForceGraphNode;
                        if (safeNode.type === 'user' && Number(safeNode.uid) > 0) {
                          setSelectedUid(Number(safeNode.uid));
                        }
                      }}
                    />
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无社交树数据" />
                )}
                <Typography.Text type="secondary">
                  最近更新：{treeUpdatedAt ? dayjs(treeUpdatedAt).format('YYYY-MM-DD HH:mm:ss') : '-'}
                </Typography.Text>
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
            <Col span={24}>
              <Card title="瓶颈建议" size="small">
                {(bottlenecks?.recommendations || []).length ? (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {(bottlenecks?.recommendations || []).map((item, index) => (
                      <Alert key={`${item}-${index}`} type="info" showIcon message={item} />
                    ))}
                  </Space>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
                <Typography.Text type="secondary">
                  总览更新时间：
                  {overviewUpdatedAt ? dayjs(overviewUpdatedAt).format('YYYY-MM-DD HH:mm:ss') : '-'}
                </Typography.Text>
              </Card>
            </Col>
          </Row>
        </>
      )}
    </PageContainer>
  );
};

export default Analysis;
