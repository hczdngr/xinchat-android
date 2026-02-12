import { BulbFilled, BulbOutlined, LinkOutlined } from '@ant-design/icons';
import type { RequestOptions } from '@@/plugin-request/request';
import type { RequestConfig, RunTimeLayoutConfig } from '@umijs/max';
import { history } from '@umijs/max';
import { Switch } from 'antd';
import React from 'react';
import {
  AvatarDropdown,
  AvatarName,
  Footer,
  Question,
  SelectLang,
} from '@/components';
import { clearAdminToken, readAdminToken } from '@/constants/adminAuth';
import { adminMe } from '@/services/admin/api';
import defaultSettings from '../config/defaultSettings';
import { errorConfig } from './requestErrorConfig';

const loginPath = '/user/login';
const THEME_STORAGE_KEY = 'xinchat_admin_layout_theme';
const FALLBACK_MENU_DATA = [
  {
    path: '/dashboard',
    name: '运营总览',
    children: [{ path: '/dashboard/analysis', name: '分析看板' }],
  },
  {
    path: '/phase',
    name: '阶段监控',
    children: [
      { path: '/phase/0', name: '事件与开关' },
      { path: '/phase/1', name: '助手与翻译' },
      { path: '/phase/2', name: '风控与反骚扰' },
      { path: '/phase/3', name: '好友关系分析' },
      { path: '/phase/4', name: '摘要中心' },
      { path: '/phase/5', name: 'VW推荐学习' },
    ],
  },
  {
    path: '/manage',
    name: '业务管理',
    children: [
      { path: '/manage/users', name: '用户管理' },
      { path: '/manage/messages', name: '消息审查' },
      { path: '/manage/products', name: '花园商品管理' },
      { path: '/manage/system', name: '系统与特性' },
    ],
  },
];

const readStoredTheme = (): 'light' | 'realDark' => {
  if (typeof window === 'undefined') return 'light';
  const saved = String(window.localStorage.getItem(THEME_STORAGE_KEY) || '')
    .trim()
    .toLowerCase();
  return saved === 'realdark' || saved === 'dark' ? 'realDark' : 'light';
};

const persistTheme = (theme: 'light' | 'realDark') => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
};

const toCurrentUser = (admin: {
  id: number;
  username: string;
  displayName: string;
  role: string;
  source?: string;
}): API.CurrentUser => {
  const displayName = String(admin.displayName || admin.username || 'Admin').trim() || 'Admin';
  return {
    userid: String(admin.id || 0),
    name: displayName,
    access: 'admin',
    title: String(admin.role || 'admin'),
    signature: admin.source ? `source: ${admin.source}` : '',
    avatar: `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(displayName)}`,
  };
};

const appendRedirect = (targetPath: string): string => {
  const { pathname, search } = history.location;
  const redirect = encodeURIComponent(`${pathname}${search}`);
  return `${targetPath}?redirect=${redirect}`;
};

export async function getInitialState(): Promise<{
  settings?: Record<string, unknown>;
  currentUser?: API.CurrentUser;
  loading?: boolean;
  fetchUserInfo?: () => Promise<API.CurrentUser | undefined>;
}> {
  const fetchUserInfo = async () => {
    const token = readAdminToken();
    if (!token) return undefined;
    try {
      const response = await adminMe();
      const admin = response?.data;
      if (!admin) return undefined;
      return toCurrentUser(admin);
    } catch {
      clearAdminToken();
      return undefined;
    }
  };

  const theme = readStoredTheme();
  const baseSettings: Record<string, unknown> = {
    ...defaultSettings,
    navTheme: theme,
    layout: 'side',
    splitMenus: false,
    fixSiderbar: true,
    fixedHeader: true,
    contentWidth: 'Fluid',
  };

  if (history.location.pathname !== loginPath) {
    const currentUser = await fetchUserInfo();
    return {
      fetchUserInfo,
      currentUser,
      settings: baseSettings,
    };
  }

  return {
    fetchUserInfo,
    settings: baseSettings,
  };
}

export const layout: RunTimeLayoutConfig = ({
  initialState,
  setInitialState,
}) => ({
  menuRender: (_, defaultDom) => defaultDom,
  menuDataRender: (menuData) => {
    if (Array.isArray(menuData) && menuData.length > 0) {
      return menuData;
    }
    return FALLBACK_MENU_DATA;
  },
  actionsRender: () => {
    const isDark = initialState?.settings?.navTheme === 'realDark';
    return [
      <Switch
        key="theme-toggle"
        checked={isDark}
        checkedChildren={<BulbFilled />}
        unCheckedChildren={<BulbOutlined />}
        onChange={(checked) => {
          const nextTheme: 'light' | 'realDark' = checked ? 'realDark' : 'light';
          persistTheme(nextTheme);
          setInitialState((prev) => ({
            ...prev,
            settings: {
              ...(prev?.settings || {}),
              navTheme: nextTheme,
            },
          }));
        }}
      />,
      <Question key="doc" />,
      <SelectLang key="lang" />,
    ];
  },
  avatarProps: {
    src: initialState?.currentUser?.avatar,
    title: <AvatarName />,
    render: (_, avatarChildren) => <AvatarDropdown>{avatarChildren}</AvatarDropdown>,
  },
  footerRender: () => <Footer />,
  onPageChange: () => {
    const { pathname } = history.location;
    if (!initialState?.currentUser && pathname !== loginPath) {
      history.push(appendRedirect(loginPath));
    }
  },
  menuHeaderRender: undefined,
  links: [
    <a
      key="pro-doc"
      href="https://pro.ant.design/docs/getting-started/"
      target="_blank"
      rel="noreferrer"
    >
      <LinkOutlined />
      <span>Pro Docs</span>
    </a>,
  ],
  ...initialState?.settings,
  layout: 'side',
  splitMenus: false,
  fixSiderbar: true,
  fixedHeader: true,
  contentWidth: 'Fluid',
});

export const request: RequestConfig = {
  timeout: 12_000,
  withCredentials: true,
  ...errorConfig,
  requestInterceptors: [
    (config: RequestOptions) => {
      const nextConfig = {
        ...config,
        headers: {
          ...(config.headers || {}),
        },
      };
      const url = String(config?.url || '');
      if (url.includes('/api/admin')) {
        const token = readAdminToken();
        if (token) {
          nextConfig.headers = {
            ...nextConfig.headers,
            'X-Admin-Token': token,
            Authorization: `Bearer ${token}`,
          };
        }
      }
      return nextConfig;
    },
  ],
  responseInterceptors: [
    (response: any) => {
      if (response.status === 401) {
        const requestUrl = String(response?.config?.url || '');
        if (requestUrl.includes('/api/admin')) {
          clearAdminToken();
          if (history.location.pathname !== loginPath) {
            history.push(appendRedirect(loginPath));
          }
        }
      }
      return response;
    },
  ],
};
