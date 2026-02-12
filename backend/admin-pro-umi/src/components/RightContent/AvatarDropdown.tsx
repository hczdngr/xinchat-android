import { LogoutOutlined } from '@ant-design/icons';
import { history, useModel } from '@umijs/max';
import type { MenuProps } from 'antd';
import { Spin } from 'antd';
import { createStyles } from 'antd-style';
import React from 'react';
import { flushSync } from 'react-dom';
import { clearAdminToken } from '@/constants/adminAuth';
import { adminLogout } from '@/services/admin/api';
import HeaderDropdown from '../HeaderDropdown';

export type GlobalHeaderRightProps = {
  menu?: boolean;
  children?: React.ReactNode;
};

export const AvatarName = () => {
  const { initialState } = useModel('@@initialState');
  const { currentUser } = initialState || {};
  return <span className="anticon">{currentUser?.name || 'Admin'}</span>;
};

const useStyles = createStyles(({ token }) => ({
  action: {
    display: 'flex',
    height: '48px',
    marginLeft: 'auto',
    overflow: 'hidden',
    alignItems: 'center',
    padding: '0 8px',
    cursor: 'pointer',
    borderRadius: token.borderRadius,
    '&:hover': {
      backgroundColor: token.colorBgTextHover,
    },
  },
}));

export const AvatarDropdown: React.FC<GlobalHeaderRightProps> = ({ children }) => {
  const { styles } = useStyles();
  const { initialState, setInitialState } = useModel('@@initialState');

  const loginOut = async () => {
    try {
      await adminLogout();
    } catch {
      // ignore logout request errors and clear local session anyway
    }
    clearAdminToken();
    const { search, pathname } = window.location;
    const redirect = encodeURIComponent(`${pathname}${search}`);
    history.replace(`/user/login?redirect=${redirect}`);
  };

  const onMenuClick: MenuProps['onClick'] = (event) => {
    const { key } = event;
    if (key !== 'logout') return;
    flushSync(() => {
      setInitialState((s) => ({ ...s, currentUser: undefined }));
    });
    void loginOut();
  };

  const loading = (
    <span className={styles.action}>
      <Spin size="small" style={{ marginLeft: 8, marginRight: 8 }} />
    </span>
  );

  if (!initialState) return loading;
  const { currentUser } = initialState;
  if (!currentUser || !currentUser.name) return loading;

  return (
    <HeaderDropdown
      menu={{
        selectedKeys: [],
        onClick: onMenuClick,
        items: [
          {
            key: 'logout',
            icon: <LogoutOutlined />,
            label: '退出登录',
          },
        ],
      }}
    >
      {children}
    </HeaderDropdown>
  );
};
