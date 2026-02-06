import React, { useState } from 'react';
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

const webInputNoOutline =
  Platform.OS === 'web' ? ({ outlineStyle: 'none', boxShadow: 'none' } as any) : null;

type Props = {
  username: string;
  password: string;
  confirmPassword: string;
  loading: boolean;
  error: string;
  status: string;
  canSubmit: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
};

export default function Register({
  username,
  password,
  confirmPassword,
  loading,
  error,
  status,
  canSubmit,
  onUsernameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
  onBack,
}: Props) {
  const insets = useSafeAreaInsets();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <View
      style={[
        styles.page,
        { paddingTop: insets.top + 40, paddingBottom: 20 + insets.bottom },
      ]}
    >
      <View style={styles.titleArea}>
        <Text style={styles.title}>欢迎注册信聊</Text>
      </View>

      <View style={styles.form}>
        <View style={styles.inputGroup}>
          <TextInput
            value={username}
            placeholder="输入昵称"
            placeholderTextColor="#c0c4cc"
            onChangeText={onUsernameChange}
            style={[styles.input, webInputNoOutline]}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.inputGroup}>
          <TextInput
            value={password}
            placeholder="输入信聊密码"
            placeholderTextColor="#c0c4cc"
            onChangeText={onPasswordChange}
            style={[styles.input, webInputNoOutline]}
            autoCapitalize="none"
            secureTextEntry={!showPassword}
          />
          <Pressable onPress={() => setShowPassword((prev) => !prev)} style={styles.iconButton} hitSlop={8}>
            {showPassword ? <EyeOpenIcon /> : <EyeClosedIcon />}
          </Pressable>
        </View>

        <View style={styles.inputGroup}>
          <TextInput
            value={confirmPassword}
            placeholder="确认信聊密码"
            placeholderTextColor="#c0c4cc"
            onChangeText={onConfirmPasswordChange}
            style={[styles.input, webInputNoOutline]}
            autoCapitalize="none"
            secureTextEntry={!showConfirm}
          />
          <Pressable onPress={() => setShowConfirm((prev) => !prev)} style={styles.iconButton} hitSlop={8}>
            {showConfirm ? <EyeOpenIcon /> : <EyeClosedIcon />}
          </Pressable>
        </View>

        <Pressable
          style={[styles.registerBtn, (!canSubmit || loading) && styles.registerBtnDisabled]}
          disabled={!canSubmit || loading}
          onPress={onSubmit}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.registerText}>立即注册</Text>
          )}
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!error && status ? <Text style={styles.success}>{status}</Text> : null}

        <Pressable onPress={onBack}>
          <Text style={styles.backLink}>返回登录</Text>
        </Pressable>
      </View>

      <Text style={styles.footer}>Copyright © 2025-2026 WebClass</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    flexGrow: 1,
    minHeight: '100%',
    backgroundColor: '#f0f2f5',
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
    borderRadius: 10,
    height: 52,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  registerBtn: {
    marginTop: 12,
    height: 50,
    borderRadius: 10,
    backgroundColor: '#0099ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  registerBtnDisabled: {
    opacity: 0.6,
  },
  registerText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  error: {
    color: '#b5482b',
    fontSize: 13,
  },
  success: {
    color: '#2f6bd9',
    fontSize: 13,
  },
  backLink: {
    marginTop: 8,
    color: '#4b6fa7',
    fontSize: 13,
  },
  footer: {
    marginTop: 'auto',
    flexShrink: 0,
    textAlign: 'center',
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
