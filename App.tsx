import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
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
import { storage } from './src/storage';

const TOKEN_KEY = 'xinchat.token';
const PROFILE_KEY = 'xinchat.profile';

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
const Stack = createNativeStackNavigator();

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
      const storedToken = (await storage.getString(TOKEN_KEY)) || '';
      const storedProfile = (await storage.getJson<Profile>(PROFILE_KEY)) || emptyProfile;
      setToken(storedToken);
      setProfile(storedProfile);
    };
    void loadSession();
  }, []);

  const refreshProfile = useCallback(async () => {
    const authToken = token || (await storage.getString(TOKEN_KEY)) || '';
    if (!authToken) return;
    try {
      const response = await fetch(`${API_BASE}/api/profile`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && data?.user) {
        setProfile((prev) => ({ ...prev, ...data.user }));
        await storage.setJson(PROFILE_KEY, {
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
    await storage.setString(TOKEN_KEY, nextToken);
    await storage.setJson(PROFILE_KEY, nextProfile);
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
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  appRoot: {
    flex: 1,
    minHeight: '100%',
  },
});

export default App;

