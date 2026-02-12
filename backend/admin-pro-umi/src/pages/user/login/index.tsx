import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { LoginForm, ProFormText } from '@ant-design/pro-components';
import {
  Helmet,
  SelectLang,
  useIntl,
  useModel,
} from '@umijs/max';
import { Alert, App } from 'antd';
import { createStyles } from 'antd-style';
import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { Footer } from '@/components';
import { writeAdminToken } from '@/constants/adminAuth';
import { adminLogin } from '@/services/admin/api';
import Settings from '../../../../config/defaultSettings';

const useStyles = createStyles(({ token }) => ({
  lang: {
    width: 42,
    height: 42,
    lineHeight: '42px',
    position: 'fixed',
    right: 16,
    borderRadius: token.borderRadius,
    ':hover': {
      backgroundColor: token.colorBgTextHover,
    },
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'auto',
    backgroundImage:
      "url('https://gw.alipayobjects.com/zos/bmw-prod/76f91f43-47f8-47cb-9cb2-3a1dad09c5df.svg')",
    backgroundSize: 'cover',
  },
}));

const Lang = () => {
  const { styles } = useStyles();
  return <div className={styles.lang}>{SelectLang && <SelectLang />}</div>;
};

const Login: React.FC = () => {
  const [errorMessage, setErrorMessage] = useState('');
  const { initialState, setInitialState } = useModel('@@initialState');
  const { styles } = useStyles();
  const { message } = App.useApp();
  const intl = useIntl();

  const fetchUserInfo = async () => {
    const userInfo = await initialState?.fetchUserInfo?.();
    if (!userInfo) return;
    flushSync(() => {
      setInitialState((state) => ({
        ...state,
        currentUser: userInfo,
      }));
    });
  };

  const handleSubmit = async (values: { username?: string; password?: string }) => {
    const username = String(values.username || '').trim();
    const password = String(values.password || '');
    if (!username || !password) {
      setErrorMessage('请输入管理员账号和密码');
      return;
    }

    try {
      const response = await adminLogin({ username, password });
      const token = String(response?.data?.token || '').trim();
      if (!token) {
        setErrorMessage('登录成功但未获取到管理员令牌');
        return;
      }
      writeAdminToken(token);
      await fetchUserInfo();
      message.success('管理员登录成功');
      const params = new URL(window.location.href).searchParams;
      const redirect = params.get('redirect');
      window.location.href = redirect || '/admin/phase/0';
    } catch (error) {
      const rawMessage =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      setErrorMessage(rawMessage || '管理员登录失败，请检查账号密码');
    }
  };

  return (
    <div className={styles.container}>
      <Helmet>
        <title>
          {intl.formatMessage({
            id: 'menu.login',
            defaultMessage: '登录',
          })}
          {Settings.title ? ` - ${Settings.title}` : ''}
        </title>
      </Helmet>
      <Lang />
      <div style={{ flex: 1, padding: '32px 0' }}>
        <LoginForm
          contentStyle={{
            minWidth: 280,
            maxWidth: '75vw',
          }}
          logo={<img alt="logo" src="/admin/logo.svg" />}
          title="XinChat Admin"
          subTitle="管理员后台登录"
          onFinish={handleSubmit}
        >
          {errorMessage ? (
            <Alert
              style={{ marginBottom: 24 }}
              message={errorMessage}
              type="error"
              showIcon
            />
          ) : null}
          <ProFormText
            name="username"
            fieldProps={{
              size: 'large',
              prefix: <UserOutlined />,
            }}
            placeholder="管理员用户名"
            rules={[{ required: true, message: '请输入管理员用户名' }]}
          />
          <ProFormText.Password
            name="password"
            fieldProps={{
              size: 'large',
              prefix: <LockOutlined />,
            }}
            placeholder="管理员密码"
            rules={[{ required: true, message: '请输入管理员密码' }]}
          />
        </LoginForm>
      </div>
      <Footer />
    </div>
  );
};

export default Login;
