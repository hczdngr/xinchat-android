import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Home from './src/components/Home';
import Login from './src/components/Login';
import Register from './src/components/Register';
import Profile from './src/components/Profile';
import EditProfile from './src/components/EditProfile';
import QRScan from './src/components/QRScan';
import InAppBrowser from './src/components/InAppBrowser';
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
  hasSuicideIntent?: boolean;
};

const emptyProfile: Profile = {};
const DEFAULT_SUICIDE_HINT =
  '你并不孤单。请先照顾好自己，必要时及时联系家人朋友或专业心理支持。';
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
  const [suicideHintVisible, setSuicideHintVisible] = useState(false);
  const [shownSuicideHintUid, setShownSuicideHintUid] = useState<number | null>(null);
  const [suicideHintMessage, setSuicideHintMessage] = useState(DEFAULT_SUICIDE_HINT);

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
          hasSuicideIntent: data.user.hasSuicideIntent === true,
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
      hasSuicideIntent: data.hasSuicideIntent === true,
    };
    await storage.setString(STORAGE_KEYS.token, nextToken);
    await storage.setJson(STORAGE_KEYS.profile, nextProfile);
    setToken(nextToken);
    setProfile(nextProfile);
  };

  const fetchDynamicSuicideHint = useCallback(async (authToken: string) => {
    if (!authToken) return { shouldShow: false, tip: DEFAULT_SUICIDE_HINT };
    try {
      const response = await fetch(`${API_BASE}/api/insight/warm-tip`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success) {
        const shouldShow = data?.shouldShow === true;
        const tip =
          typeof data?.tip === 'string' && data.tip.trim()
            ? data.tip.trim()
            : DEFAULT_SUICIDE_HINT;
        return { shouldShow, tip };
      }
    } catch {}
    return { shouldShow: false, tip: DEFAULT_SUICIDE_HINT };
  }, []);

  useEffect(() => {
    if (!token) return;
    refreshProfile().catch(() => undefined);
  }, [token, refreshProfile]);

  useEffect(() => {
    if (!token) {
      setSuicideHintVisible(false);
      setShownSuicideHintUid(null);
      return;
    }
    const uid = Number(profile.uid);
    if (!Number.isInteger(uid)) return;
    if (shownSuicideHintUid === uid) return;
    let cancelled = false;
    const prepareHint = async () => {
      const result = await fetchDynamicSuicideHint(token);
      if (cancelled) return;
      setShownSuicideHintUid(uid);
      if (!result.shouldShow) {
        setSuicideHintVisible(false);
        return;
      }
      setSuicideHintMessage(result.tip);
      setSuicideHintVisible(true);
    };
    prepareHint().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fetchDynamicSuicideHint, profile.uid, shownSuicideHintUid, token]);

  useEffect(() => {
    if (!suicideHintVisible) return;
    const timer = setTimeout(() => {
      setSuicideHintVisible(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [suicideHintVisible]);

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
    <SafeAreaProvider style={styles.appRoot}>
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
            <NavigationContainer style={styles.appRoot}>
              <Stack.Navigator
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: '#f2f2f7' },
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
        {isAuthed && suicideHintVisible ? (
          <View style={styles.suicideHintOverlay}>
            <Pressable style={styles.suicideHintBackdrop} onPress={() => setSuicideHintVisible(false)} />
            <View style={styles.suicideHintCard}>
              <Pressable
                style={styles.suicideHintClose}
                onPress={() => setSuicideHintVisible(false)}
                hitSlop={10}
              >
                <Text style={styles.suicideHintCloseText}>×</Text>
              </Pressable>
              <Text style={styles.suicideHintTitle}>温馨提示</Text>
              <Text style={styles.suicideHintBody}>{suicideHintMessage}</Text>
              <Text style={styles.suicideHintMeta}>该提示将在 3 秒后自动关闭</Text>
            </View>
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
  },
  suicideHintOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 300,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suicideHintBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
  },
  suicideHintCard: {
    width: '84%',
    maxWidth: 360,
    borderRadius: 14,
    backgroundColor: '#fff',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  suicideHintClose: {
    position: 'absolute',
    right: 10,
    top: 8,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suicideHintCloseText: {
    fontSize: 22,
    lineHeight: 22,
    color: '#909090',
  },
  suicideHintTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1f1f1f',
    marginBottom: 8,
    paddingRight: 22,
  },
  suicideHintBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#4a4a4a',
  },
  suicideHintMeta: {
    marginTop: 10,
    fontSize: 12,
    color: '#8a8a8a',
  },
});

export default App;

