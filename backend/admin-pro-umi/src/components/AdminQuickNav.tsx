import { Space, Button } from 'antd';
import { history } from '@umijs/max';
import React from 'react';

type QuickNavItem = {
  key: string;
  label: string;
  path: string;
};

const NAV_ITEMS: QuickNavItem[] = [
  { key: 'phase0', label: 'Phase0', path: '/phase/0' },
  { key: 'phase1', label: 'Phase1', path: '/phase/1' },
  { key: 'phase2', label: 'Phase2', path: '/phase/2' },
  { key: 'phase3', label: 'Phase3', path: '/phase/3' },
  { key: 'analysis', label: '运营总览', path: '/dashboard/analysis' },
  { key: 'users', label: '用户管理', path: '/manage/users' },
  { key: 'messages', label: '消息审查', path: '/manage/messages' },
  { key: 'products', label: '花园商品', path: '/manage/products' },
  { key: 'system', label: '系统配置', path: '/manage/system' },
];

type Props = {
  current?: string;
};

const AdminQuickNav: React.FC<Props> = ({ current }) => {
  return (
    <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
      {NAV_ITEMS.map((item) => (
        <Button
          key={item.key}
          size="small"
          type={current === item.key ? 'primary' : 'default'}
          onClick={() => {
            history.push(item.path);
          }}
        >
          {item.label}
        </Button>
      ))}
    </Space>
  );
};

export default AdminQuickNav;
