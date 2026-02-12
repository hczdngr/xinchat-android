import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, InputNumber, Row, Select, Space, Statistic, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import ForceGraph2D from 'react-force-graph-2d';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AdminRelationshipOpsSnapshot,
  SocialOverview,
  SocialTree,
  SocialTreeEdge,
  SocialTreeNode,
} from '@/services/admin/api';
import { fetchAdminRelationshipOps, fetchSocialOverview, fetchSocialTree } from '@/services/admin/api';

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

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: string }).message || '请求失败');
  }
  return '请求失败';
};

const Phase3: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  const [socialOverview, setSocialOverview] = useState<SocialOverview | null>(null);
  const [relationship, setRelationship] = useState<AdminRelationshipOpsSnapshot | null>(null);
  const [socialTree, setSocialTree] = useState<SocialTree | null>(null);

  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [scope, setScope] = useState<'all' | 'private' | 'group'>('all');
  const [windowDays, setWindowDays] = useState<7 | 30>(7);
  const [includeStable, setIncludeStable] = useState(false);
  const [treeDepth, setTreeDepth] = useState(2);
  const [includeGroups, setIncludeGroups] = useState(true);

  const graphWrapRef = useRef<HTMLDivElement | null>(null);
  const [graphSize, setGraphSize] = useState({ width: 960, height: 560 });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewResp, relationshipResp] = await Promise.all([
        fetchSocialOverview(),
        fetchAdminRelationshipOps({
          uid: selectedUid || undefined,
          scope,
          windowDays,
          includeStable,
          limit: 50,
        }),
      ]);
      const overview = overviewResp.data || null;
      const rel = relationshipResp.data || null;
      setSocialOverview(overview);
      setRelationship(rel);

      const resolvedUid = Number(rel?.selectedUid || selectedUid || 0);
      if (resolvedUid > 0) {
        const treeResp = await fetchSocialTree({
          uid: resolvedUid,
          depth: treeDepth,
          includeGroups,
        });
        setSocialTree(treeResp.data || null);
        if (resolvedUid !== Number(selectedUid || 0)) {
          setSelectedUid(resolvedUid);
        }
      } else {
        setSocialTree(null);
      }

      setErrorText('');
    } catch (error) {
      setErrorText(toErrorText(error));
    } finally {
      setLoading(false);
    }
  }, [includeGroups, includeStable, scope, selectedUid, treeDepth, windowDays]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!graphWrapRef.current || typeof ResizeObserver === 'undefined') return;
    const host = graphWrapRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.max(320, Math.floor(entry.contentRect.width));
      const height = Math.max(420, Math.floor(Math.min(760, width * 0.6)));
      setGraphSize((prev) => {
        if (prev.width === width && prev.height === height) return prev;
        return { width, height };
      });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

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

  const relationshipColumns: ColumnsType<AdminRelationshipOpsSnapshot['items'][number]> = useMemo(
    () => [
      {
        title: '目标',
        dataIndex: 'title',
        ellipsis: true,
      },
      {
        title: '类型',
        width: 100,
        render: (_, record) => <Tag>{record.targetType}</Tag>,
      },
      {
        title: '下降分',
        dataIndex: 'score',
        width: 100,
      },
      {
        title: '7天下降',
        width: 100,
        render: (_, record) => `${record.metrics.declineRate7d}%`,
      },
      {
        title: '30天下降',
        width: 110,
        render: (_, record) => `${record.metrics.declineRate30d}%`,
      },
      {
        title: '最近互动',
        width: 170,
        render: (_, record) => (record.lastInteractionAt ? dayjs(record.lastInteractionAt).format('YYYY-MM-DD HH:mm') : '-'),
      },
      {
        title: '建议动作',
        width: 220,
        render: (_, record) => `${record.recommendation.label} · ${record.recommendation.reason}`,
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
            <Statistic title="用户总数" value={socialOverview?.totals?.users || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="群组数" value={socialOverview?.totals?.groups || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="互好友边" value={socialOverview?.totals?.mutualFriendEdges || 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="7天无互动" value={relationship?.summary?.inactive7d || 0} />
          </Card>
        </Col>
      </Row>

      <Card
        title="互动下降榜单（最近7/30天）"
        size="small"
        style={{ marginTop: 16 }}
        extra={
          <Space wrap>
            <Typography.Text type="secondary">用户</Typography.Text>
            <Select
              style={{ width: 260 }}
              value={selectedUid || undefined}
              placeholder="选择用户"
              showSearch
              optionFilterProp="label"
              options={(relationship?.selector?.users || []).map((item) => ({
                label: `${item.uid} · ${item.nickname || item.username} (F${item.friendsCount}/G${item.groupsCount})`,
                value: item.uid,
              }))}
              onChange={(value) => setSelectedUid(Number(value) || null)}
            />
            <Typography.Text type="secondary">范围</Typography.Text>
            <Select
              style={{ width: 120 }}
              value={scope}
              options={[
                { label: '全部', value: 'all' },
                { label: '好友', value: 'private' },
                { label: '群组', value: 'group' },
              ]}
              onChange={(value) => setScope(value)}
            />
            <Typography.Text type="secondary">窗口</Typography.Text>
            <Select
              style={{ width: 120 }}
              value={windowDays}
              options={[
                { label: '7天', value: 7 },
                { label: '30天', value: 30 },
              ]}
              onChange={(value) => setWindowDays(value)}
            />
            <Typography.Text type="secondary">含稳定关系</Typography.Text>
            <Switch checked={includeStable} onChange={setIncludeStable} />
          </Space>
        }
      >
        <Table
          size="small"
          rowKey={(record) => `${record.targetType}-${record.targetUid}`}
          pagination={false}
          dataSource={relationship?.items || []}
          columns={relationshipColumns}
          scroll={{ x: 1100, y: 320 }}
        />
      </Card>

      <Card
        title="个人社交树（力导图）"
        size="small"
        style={{ marginTop: 16 }}
        extra={
          <Space wrap>
            <Typography.Text type="secondary">根UID</Typography.Text>
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
          交互说明：滚轮缩放，拖拽节点改变布局，右键节点可解除固定，点击用户节点会切换为新的根用户。
        </Typography.Paragraph>
        {socialTree && graphData.nodes.length > 0 ? (
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
              linkWidth={(link: unknown) => ((link as ForceGraphLink).type === 'friend' ? 1.8 : 1)}
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
          <Alert type="info" showIcon message="暂无社交树数据" />
        )}
      </Card>
    </PageContainer>
  );
};

export default Phase3;
