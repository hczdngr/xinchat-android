import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import Svg, { Path } from 'react-native-svg';
import type { InAppBrowserRoute, RootNavigation } from '../navigation/types';

export default function InAppBrowser() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<InAppBrowserRoute>();
  const insets = useSafeAreaInsets();
  const url = String(route.params?.url || '').trim();
  const title = String(route.params?.title || '网页');

  const safeUrl = useMemo(() => {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return '';
  }, [url]);

  return (
    <View style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <BackIcon />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>
      {safeUrl ? (
        <WebView
          source={{ uri: safeUrl }}
          style={styles.webView}
          startInLoadingState
          allowsBackForwardNavigationGestures
        />
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>链接无效，无法打开。</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    height: 52,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 10,
  },
  backBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontSize: 16,
    color: '#111',
    fontWeight: '600',
  },
  webView: {
    flex: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: '#666',
    fontSize: 14,
  },
});

function BackIcon() {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#222"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}




