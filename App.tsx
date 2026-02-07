import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform, StatusBar, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Home from './src/components/Home';
import Login from './src/components/Login';
import Register from './src/components/Register';
import Profile from './src/components/Profile';
import FriendProfile from './src/components/FriendProfile';
import EditProfile from './src/components/EditProfile';
import QRScan from './src/components/QRScan';
import InAppBrowser from './src/components/InAppBrowser';
import ChatSettings from './src/components/ChatSettings';
import CreateGroup from './src/components/CreateGroup';
import GroupChatSettings from './src/components/GroupChatSettings';
import GroupChatSearch from './src/components/GroupChatSearch';
import { API_BASE } from './src/config';
import { STORAGE_KEYS } from './src/constants/storageKeys';
import type { RootStackParamList } from './src/navigation/types';
import { storage } from './src/storage';

type Profile = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  gender?: string;
  birthday?: string;
  country?: string;
  province?: string;
  region?: string;
  tokenExpiresAt?: string | number;
};

const emptyProfile: Profile = {};
const Stack = createNativeStackNavigator<RootStackParamList>();

function App() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [view, setView] = useState<'login' | 'register'>('login');

  const [registerUsername, setRegisterUsername] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('');
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [registerStatus, setRegisterStatus] = useState('');

  const [token, setToken] = useState('');
  const [profile, setProfile] = useState<Profile>(emptyProfile);

  const canSubmit = useMemo(() => username.trim().length > 0 && password.length > 0, [
    username,
    password,
  ]);
  const canRegister = useMemo(() => {
    const nameOk = registerUsername.trim().length > 0;
    const pwdOk = registerPassword.length > 0;
    const confirmOk =
      registerConfirmPassword.length > 0 && registerConfirmPassword === registerPassword;
    return nameOk && pwdOk && confirmOk;
  }, [registerUsername, registerPassword, registerConfirmPassword]);
  const isAuthed = useMemo(() => Boolean(token), [token]);

  useEffect(() => {
    const loadSession = async () => {
      const storedToken = (await storage.getString(STORAGE_KEYS.token)) || '';
      const storedProfile =
        (await storage.getJson<Profile>(STORAGE_KEYS.profile)) || emptyProfile;
      setToken(storedToken);
      setProfile(storedProfile);
    };
    loadSession().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (isAuthed) return;
    const onBackPress = () => {
      if (view === 'register') {
        setRegisterError('');
        setRegisterStatus('');
        setRegisterConfirmPassword('');
        setView('login');
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [isAuthed, view]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const htmlStyle = document.documentElement.style;
    const bodyStyle = document.body?.style;
    const rootEl = document.getElementById('root');
    const rootStyle = rootEl?.style;
    if (!bodyStyle || !rootStyle) return;

    const prev = {
      htmlOverflow: htmlStyle.overflow,
      htmlOverscroll: (htmlStyle as any).overscrollBehavior,
      htmlHeight: htmlStyle.height,
      bodyOverflow: bodyStyle.overflow,
      bodyOverscroll: (bodyStyle as any).overscrollBehavior,
      bodyMargin: bodyStyle.margin,
      bodyHeight: bodyStyle.height,
      bodyWidth: bodyStyle.width,
      rootOverflow: rootStyle.overflow,
      rootHeight: rootStyle.height,
      rootWidth: rootStyle.width,
    };

    htmlStyle.height = '100%';
    htmlStyle.overflow = 'hidden';
    (htmlStyle as any).overscrollBehavior = 'none';

    bodyStyle.margin = '0';
    bodyStyle.width = '100%';
    bodyStyle.height = '100%';
    bodyStyle.overflow = 'hidden';
    (bodyStyle as any).overscrollBehavior = 'none';

    rootStyle.width = '100%';
    rootStyle.height = '100%';
    rootStyle.overflow = 'hidden';

    return () => {
      htmlStyle.overflow = prev.htmlOverflow;
      (htmlStyle as any).overscrollBehavior = prev.htmlOverscroll;
      htmlStyle.height = prev.htmlHeight;

      bodyStyle.overflow = prev.bodyOverflow;
      (bodyStyle as any).overscrollBehavior = prev.bodyOverscroll;
      bodyStyle.margin = prev.bodyMargin;
      bodyStyle.height = prev.bodyHeight;
      bodyStyle.width = prev.bodyWidth;

      rootStyle.overflow = prev.rootOverflow;
      rootStyle.height = prev.rootHeight;
      rootStyle.width = prev.rootWidth;
    };
  }, []);

  const refreshProfile = useCallback(async () => {
    const authToken = token || (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!authToken) return;
    try {
      const response = await fetch(`${API_BASE}/api/profile`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && data?.user) {
        setProfile((prev) => ({ ...prev, ...data.user }));
        await storage.setJson(STORAGE_KEYS.profile, {
          uid: data.user.uid,
          username: data.user.username,
          nickname: data.user.nickname,
          avatar: data.user.avatar,
          signature: data.user.signature,
          gender: data.user.gender,
          birthday: data.user.birthday,
          country: data.user.country,
          province: data.user.province,
          region: data.user.region,
        });
      }
    } catch {}
  }, [token]);

  const setAuthSession = async (data: Profile & { token?: string }) => {
    const nextToken = data.token || '';
    const nextProfile: Profile = {
      uid: data.uid,
      username: data.username,
      nickname: data.nickname,
      avatar: data.avatar,
      signature: data.signature,
      gender: data.gender,
      birthday: data.birthday,
      country: data.country,
      province: data.province,
      region: data.region,
      tokenExpiresAt: data.tokenExpiresAt,
    };
    await storage.setString(STORAGE_KEYS.token, nextToken);
    await storage.setJson(STORAGE_KEYS.profile, nextProfile);
    setToken(nextToken);
    setProfile(nextProfile);
  };

  const submit = async () => {
    setError('');
    setStatus('');

    if (!canSubmit) {
      setError('Please enter username and password.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(API_BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        setError(data?.message || 'Login failed. Please try again.');
        return;
      }

      await setAuthSession(data);
      setStatus(data?.message || 'Login successful.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('Login request failed', { base: API_BASE, error: message });
      setError('Network error: ' + message);
    } finally {
      setLoading(false);
    }
  };

  const goRegister = () => {
    setRegisterError('');
    setRegisterStatus('');
    setRegisterConfirmPassword('');
    setView('register');
  };

  const goLogin = () => {
    setError('');
    setStatus('');
    setView('login');
  };

  const register = async () => {
    setRegisterError('');
    setRegisterStatus('');

    if (!canRegister) {
      if (!registerUsername.trim() || !registerPassword) {
        setRegisterError('Please enter username and password.');
      } else if (registerConfirmPassword !== registerPassword) {
        setRegisterError('Passwords do not match.');
      } else {
        setRegisterError('Please confirm password.');
      }
      return;
    }

    setRegisterLoading(true);
    try {
      const response = await fetch(API_BASE + '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: registerUsername.trim(),
          password: registerPassword,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        setRegisterError(data?.message || 'Register failed. Please try again.');
        return;
      }

      setRegisterStatus(data?.message || 'Register successful.');

      const loginResponse = await fetch(API_BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: registerUsername.trim(),
          password: registerPassword,
        }),
      });

      const loginData = await loginResponse.json().catch(() => ({}));
      if (!loginResponse.ok || !loginData?.success) {
        setRegisterError(loginData?.message || 'Auto login failed. Please login manually.');
        return;
      }

      await setAuthSession(loginData);
      setView('login');
      setRegisterConfirmPassword('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('Register request failed', { base: API_BASE, error: message });
      setRegisterError('Network error: ' + message);
    } finally {
      setRegisterLoading(false);
    }
  };

  return (
    <SafeAreaProvider>
      <View style={styles.appRoot}>
        <StatusBar barStyle={'dark-content'} />
        {!isAuthed && view === 'login' ? (
          <Login
            username={username}
            password={password}
            showPassword={showPassword}
            loading={loading}
            error={error}
            status={status}
            canSubmit={canSubmit}
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
            onTogglePassword={() => setShowPassword((prev) => !prev)}
            onSubmit={submit}
            onGoRegister={goRegister}
          />
        ) : null}
        {!isAuthed && view === 'register' ? (
          <Register
            username={registerUsername}
            password={registerPassword}
            confirmPassword={registerConfirmPassword}
            loading={registerLoading}
            error={registerError}
            status={registerStatus}
            canSubmit={canRegister}
            onUsernameChange={setRegisterUsername}
            onPasswordChange={setRegisterPassword}
            onConfirmPasswordChange={setRegisterConfirmPassword}
            onSubmit={register}
            onBack={goLogin}
          />
        ) : null}
        {isAuthed ? (
          <View style={styles.appRoot}>
            <NavigationContainer>
              <Stack.Navigator
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: '#f2f2f7' },
                  animation: Platform.OS === 'ios' ? 'default' : 'slide_from_right',
                  gestureEnabled: true,
                  fullScreenGestureEnabled: true,
                }}
              >
                <Stack.Screen name="Home">
                  {() => <Home profile={profile} />}
                </Stack.Screen>
                <Stack.Screen name="Profile">
                  {({ navigation }) => (
                    <Profile
                      profile={profile}
                      onBack={() => navigation.goBack()}
                      onEdit={() => navigation.navigate('EditProfile')}
                      onRefresh={refreshProfile}
                    />
                  )}
                </Stack.Screen>
                <Stack.Screen name="FriendProfile" component={FriendProfile} />
                <Stack.Screen name="ChatSettings" component={ChatSettings} />
                <Stack.Screen name="GroupChatSettings" component={GroupChatSettings} />
                <Stack.Screen name="GroupChatSearch" component={GroupChatSearch} />
                <Stack.Screen name="CreateGroup" component={CreateGroup} />
                <Stack.Screen name="EditProfile">
                  {({ navigation }) => (
                    <EditProfile
                      initialProfile={profile}
                      onBack={() => navigation.goBack()}
                      onSaved={(next) => {
                        setProfile((prev) => ({ ...prev, ...next }));
                      }}
                    />
                  )}
                </Stack.Screen>
                <Stack.Screen name="QRScan" component={QRScan} />
                <Stack.Screen name="InAppBrowser" component={InAppBrowser} />
              </Stack.Navigator>
            </NavigationContainer>
          </View>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  appRoot: {
    flex: 1,
    minHeight: '100%',
    overflow: 'hidden',
  },
});

export default App;

