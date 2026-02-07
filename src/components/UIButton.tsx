import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  ViewStyle,
  TextStyle,
  StyleProp,
} from 'react-native';

type Variant = 'primary' | 'secondary' | 'danger';

type Props = {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export default function UIButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
  textStyle,
}: Props) {
  const isDisabled = disabled || loading;
  const spinnerColor = variant === 'secondary' ? '#999' : '#fff';

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles[`${variant}Pressed`],
        style,
      ]}
    >
      <Text
        style={[
          styles.text,
          styles[`${variant}Text`],
          isDisabled && styles.disabledText,
          loading && styles.loadingText,
          textStyle,
        ]}
      >
        {title}
      </Text>
      {loading ? (
        <ActivityIndicator
          style={styles.spinner}
          color={spinnerColor}
          size="small"
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    position: 'relative',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 1,
  },
  primary: {
    backgroundColor: '#0099ff',
    shadowColor: '#0099ff',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  primaryText: {
    color: '#ffffff',
  },
  primaryPressed: {
    backgroundColor: '#0088e6',
    transform: [{ scale: 0.98 }],
    shadowOpacity: 0.2,
    shadowRadius: 6,
  },
  secondary: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  secondaryText: {
    color: '#333333',
  },
  secondaryPressed: {
    backgroundColor: '#f2f2f2',
  },
  danger: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#ff4d4f',
  },
  dangerText: {
    color: '#ff4d4f',
  },
  dangerPressed: {
    backgroundColor: '#fff0f0',
  },
  disabled: {
    backgroundColor: '#a0cfff',
    shadowOpacity: 0,
    elevation: 0,
    opacity: 0.7,
  },
  disabledText: {
    color: '#ffffff',
  },
  loadingText: {
    color: 'transparent',
  },
  spinner: {
    position: 'absolute',
  },
});
