import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
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
import type { ProductItem, ProductsSummary } from '@/services/admin/api';
import {
  createProduct,
  deleteProduct,
  fetchProducts,
  fetchProductsSummary,
  updateProduct,
} from '@/services/admin/api';

const statusColor: Record<string, string> = {
  active: 'success',
  inactive: 'warning',
  draft: 'default',
  archived: 'error',
};

const queryInit = {
  page: 1,
  pageSize: 20,
  q: '',
  status: 'all',
};

const ProductsManage: React.FC = () => {
  const { message } = App.useApp();
  const [summary, setSummary] = useState<ProductsSummary | null>(null);
  const [rows, setRows] = useState<ProductItem[]>([]);
  const [query, setQuery] = useState(queryInit);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<ProductItem | null>(null);
  const [form] = Form.useForm();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryResp, listResp] = await Promise.all([
        fetchProductsSummary(10),
        fetchProducts(query),
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
      message.error(text || '商品数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: 'draft', stock: 0, sales: 0, price: 0, cost: 0, tags: '' });
    setModalVisible(true);
  };

  const openEdit = (record: ProductItem) => {
    setEditing(record);
    form.setFieldsValue({
      ...record,
      tags: Array.isArray(record.tags) ? record.tags.join(',') : '',
    });
    setModalVisible(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const payload = {
      ...values,
      tags: String(values.tags || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      stock: Number(values.stock || 0),
      sales: Number(values.sales || 0),
      price: Number(values.price || 0),
      cost: Number(values.cost || 0),
    };
    if (editing) {
      await updateProduct({ ...payload, id: editing.id });
      message.success('商品已更新');
    } else {
      await createProduct(payload);
      message.success('商品已创建');
    }
    setModalVisible(false);
    setEditing(null);
    await reload();
  };

  const columns: ColumnsType<ProductItem> = useMemo(
    () => [
      {
        title: 'ID',
        dataIndex: 'id',
        width: 80,
      },
      {
        title: '名称',
        dataIndex: 'name',
        width: 180,
        ellipsis: true,
      },
      {
        title: 'SKU',
        dataIndex: 'sku',
        width: 140,
      },
      {
        title: '分类',
        dataIndex: 'category',
        width: 140,
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 120,
        render: (value: string) => <Tag color={statusColor[value] || 'default'}>{value}</Tag>,
      },
      {
        title: '库存',
        dataIndex: 'stock',
        width: 100,
      },
      {
        title: '销量',
        dataIndex: 'sales',
        width: 100,
      },
      {
        title: '价格',
        dataIndex: 'price',
        width: 100,
      },
      {
        title: '成本',
        dataIndex: 'cost',
        width: 100,
      },
      {
        title: '更新时间',
        dataIndex: 'updatedAt',
        width: 180,
      },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 170,
        render: (_, record) => (
          <Space size="small">
            <Button size="small" onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Popconfirm
              title="确认删除该商品?"
              onConfirm={async () => {
                await deleteProduct(record.id);
                message.success('商品已删除');
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
        <Button key="add" icon={<PlusOutlined />} type="primary" onClick={openCreate}>
          新建商品
        </Button>,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
      ]}
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={4}><Card><Statistic title="商品总数" value={summary?.total || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={4}><Card><Statistic title="在售" value={summary?.active || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={4}><Card><Statistic title="低库存" value={summary?.lowStock || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={4}><Card><Statistic title="总库存" value={summary?.totalStock || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={4}><Card><Statistic title="总销量" value={summary?.totalSales || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={4}><Card><Statistic title="销售额" value={summary?.grossRevenue || 0} precision={2} /></Card></Col>
      </Row>

      <Card style={{ marginTop: 16 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search
            allowClear
            placeholder="搜索 ID/名称/SKU/分类"
            style={{ width: 280 }}
            onSearch={(value) => setQuery((prev) => ({ ...prev, q: value.trim(), page: 1 }))}
          />
          <Select
            value={query.status}
            style={{ width: 160 }}
            onChange={(value) => setQuery((prev) => ({ ...prev, status: value, page: 1 }))}
            options={[
              { label: '全部状态', value: 'all' },
              { label: 'active', value: 'active' },
              { label: 'inactive', value: 'inactive' },
              { label: 'draft', value: 'draft' },
              { label: 'archived', value: 'archived' },
            ]}
          />
        </Space>

        <Table<ProductItem>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1500 }}
          pagination={{
            current: query.page,
            pageSize: query.pageSize,
            total,
            showSizeChanger: true,
            onChange: (page, pageSize) => setQuery((prev) => ({ ...prev, page, pageSize })),
          }}
        />
      </Card>

      <Modal
        open={modalVisible}
        title={editing ? `编辑商品 #${editing.id}` : '新建商品'}
        onCancel={() => {
          setModalVisible(false);
          setEditing(null);
        }}
        onOk={() => {
          void submit();
        }}
        width={680}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入商品名称' }]}>
                <Input maxLength={120} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="sku" label="SKU">
                <Input maxLength={64} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="category" label="分类">
                <Input maxLength={64} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="状态" rules={[{ required: true, message: '请选择状态' }]}> 
                <Select
                  options={[
                    { label: 'active', value: 'active' },
                    { label: 'inactive', value: 'inactive' },
                    { label: 'draft', value: 'draft' },
                    { label: 'archived', value: 'archived' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="description" label="描述">
                <Input.TextArea rows={3} maxLength={600} showCount />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="price" label="价格"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="cost" label="成本"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="stock" label="库存"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="sales" label="销量"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="tags" label="标签（逗号分隔）">
                <Input maxLength={200} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </PageContainer>
  );
};

export default ProductsManage;
