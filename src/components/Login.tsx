import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';

type Props = {
  username: string;
  password: string;
  showPassword: boolean;
  loading: boolean;
  error: string;
  status: string;
  canSubmit: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onTogglePassword: () => void;
  onSubmit: () => void;
  onGoRegister: () => void;
};

const inputShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.08)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.04,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 8,
        elevation: 1,
      };

export default function Login({
  username,
  password,
  showPassword,
  loading,
  error,
  status,
  canSubmit,
  onUsernameChange,
  onPasswordChange,
  onTogglePassword,
  onSubmit,
  onGoRegister,
}: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.page,
        { paddingTop: insets.top + 40, paddingBottom: 30 + insets.bottom },
      ]}
    >
      <View style={styles.titleArea}>
        <Text style={styles.title}>添加账号</Text>
      </View>

      <View style={styles.form}>
        <View style={styles.inputGroup}>
          <TextInput
            value={username}
            placeholder="输入昵称"
            placeholderTextColor="#c0c4cc"
            onChangeText={onUsernameChange}
            style={styles.input}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.inputGroup}>
          <TextInput
            value={password}
            placeholder="输入信聊密码"
            placeholderTextColor="#c0c4cc"
            onChangeText={onPasswordChange}
            style={styles.input}
            autoCapitalize="none"
            secureTextEntry={!showPassword}
          />
          <Pressable onPress={onTogglePassword} style={styles.iconButton} hitSlop={8}>
            {showPassword ? <EyeOpenIcon /> : <EyeClosedIcon />}
          </Pressable>
        </View>

        <Pressable
          style={[styles.loginBtn, (!canSubmit || loading) && styles.loginBtnDisabled]}
          disabled={!canSubmit || loading}
          onPress={onSubmit}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.loginBtnText}>登录</Text>
          )}
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!error && status ? <Text style={styles.success}>{status}</Text> : null}
      </View>

      <View style={styles.footer}>
        <Pressable style={styles.registerBtn} onPress={onGoRegister}>
          <RegisterPlusIcon />
        </Pressable>
        <Text style={styles.copyright}>Copyright © 2025-2026 WebClass</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f2f3f5',
    paddingHorizontal: 24,
  },
  titleArea: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#1a1a1a',
    letterSpacing: 1,
  },
  form: {
    gap: 16,
  },
  inputGroup: {
    backgroundColor: '#fff',
    borderRadius: 12,
    height: 54,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    ...inputShadowStyle,
    position: 'relative',
  },
  input: {
    flex: 1,
    width: '100%',
    fontSize: 16,
    color: '#333',
    textAlign: 'center',
    paddingHorizontal: 36,
  },
  iconButton: {
    position: 'absolute',
    right: 14,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  loginBtn: {
    marginTop: 20,
    height: 50,
    borderRadius: 12,
    backgroundColor: '#4a9df8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginBtnDisabled: {
    opacity: 0.6,
  },
  loginBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 1,
  },
  error: {
    color: '#b5482b',
    fontSize: 13,
  },
  success: {
    color: '#2f6bd9',
    fontSize: 13,
  },
  footer: {
    marginTop: 'auto',
    alignItems: 'center',
    gap: 12,
  },
  registerBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e5e5e5',
  },
  copyright: {
    fontSize: 11,
    color: '#999',
  },
});

function EyeClosedIcon() {
  return (
    <Svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#999" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <Line x1="1" y1="1" x2="23" y2="23" />
    </Svg>
  );
}

function EyeOpenIcon() {
  return (
    <Svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#999" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <Circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

function RegisterPlusIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5V19M5 12H19" stroke="#666666" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
