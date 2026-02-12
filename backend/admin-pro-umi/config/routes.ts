export default [
  {
    path: '/user',
    layout: false,
    routes: [
      {
        name: 'admin_login',
        path: '/user/login',
        component: './user/login',
      },
    ],
  },
  {
    path: '/',
    redirect: '/dashboard/analysis',
    hideInMenu: true,
  },
  {
    path: '/dashboard',
    name: '运营总览',
    icon: 'dashboard',
    routes: [
      {
        path: '/dashboard/analysis',
        name: '分析看板',
        component: './Dashboard/Analysis',
      },
    ],
  },
  {
    path: '/phase',
    name: '阶段监控',
    icon: 'appstore',
    routes: [
      {
        path: '/phase/0',
        name: '事件与开关',
        icon: 'setting',
        component: './Phases/Phase0',
      },
      {
        path: '/phase/1',
        name: '助手与翻译',
        icon: 'experiment',
        component: './Phases/Phase1',
      },
      {
        path: '/phase/2',
        name: '风控与反骚扰',
        icon: 'warning',
        component: './Phases/Phase2',
      },
      {
        path: '/phase/3',
        name: '好友关系分析',
        icon: 'apartment',
        component: './Phases/Phase3',
      },
      {
        path: '/phase/4',
        name: '摘要中心',
        icon: 'file-text',
        component: './Phases/Phase4',
      },
      {
        path: '/phase/5',
        name: 'VW推荐学习',
        icon: 'line-chart',
        component: './Phases/Phase5',
      },
    ],
  },
  {
    path: '/manage',
    name: '业务管理',
    icon: 'tool',
    routes: [
      {
        path: '/manage/users',
        name: '用户管理',
        icon: 'team',
        component: './Users/Manage',
      },
      {
        path: '/manage/messages',
        name: '消息审查',
        icon: 'message',
        component: './Messages/Review',
      },
      {
        path: '/manage/products',
        name: '花园商品管理',
        icon: 'shop',
        component: './Products/Manage',
      },
      {
        path: '/manage/system',
        name: '系统与特性',
        icon: 'setting',
        component: './System/Control',
      },
    ],
  },
  {
    path: '/users/manage',
    redirect: '/manage/users',
    hideInMenu: true,
  },
  {
    path: '/messages/review',
    redirect: '/manage/messages',
    hideInMenu: true,
  },
  {
    path: '/products/manage',
    redirect: '/manage/products',
    hideInMenu: true,
  },
  {
    path: '/system/control',
    redirect: '/manage/system',
    hideInMenu: true,
  },
  {
    path: '*',
    component: './404',
    layout: false,
  },
];
