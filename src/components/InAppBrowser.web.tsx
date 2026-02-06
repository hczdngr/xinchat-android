import React, { useMemo } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { InAppBrowserRoute, RootNavigation } from '../navigation/types';

export default function InAppBrowserWeb() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<InAppBrowserRoute>();
  const url = String(route.params?.url || '').trim();
  const title = String(route.params?.title || '网页');

  const safeUrl = useMemo(() => {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return '';
  }, [url]);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <button type="button" style={styles.backBtn} onClick={() => navigation.goBack()}>
          {'<'}
        </button>
        <div style={styles.title}>{title}</div>
      </div>
      {safeUrl ? (
        <iframe title={title} src={safeUrl} style={styles.iframe} />
      ) : (
        <div style={styles.empty}>链接无效，无法打开。</div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    width: '100%',
    height: '100%',
    minHeight: '100vh',
    backgroundColor: '#fff',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    height: 52,
    borderBottom: '1px solid #eee',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 12px',
    flexDirection: 'row',
    flexShrink: 0,
  },
  backBtn: {
    width: 34,
    height: 34,
    border: 0,
    borderRadius: 17,
    background: 'transparent',
    color: '#222',
    fontSize: 22,
    cursor: 'pointer',
  },
  title: {
    flex: 1,
    color: '#111',
    fontSize: 16,
    fontWeight: 600,
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 0,
    flex: 1,
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#666',
    fontSize: 14,
  },
};




