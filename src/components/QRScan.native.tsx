import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native';
import type { RootNavigation } from '../navigation/types';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { decodeQrFromBase64 } from '../utils/decodeQrFromBase64';
import { pickQrImageForPlatform } from '../utils/pickQrImage';
import { normalizeScannedUrl } from './qrUtils';
import { QR_SCAN_MODE_ITEMS, QR_SCAN_TEXT, type ScanMode } from './qrScanShared';


export default function QRScan() {
  const navigation = useNavigation<RootNavigation>();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const screen = Dimensions.get('window');
  const targetAspect = Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height);
  const cameraFormat = useCameraFormat(device, [
    { videoAspectRatio: targetAspect },
    { videoResolution: { width: 1280, height: 720 } },
    { fps: 'max' },
  ]);
  const [scanAreaHeight, setScanAreaHeight] = useState(220);
  const [zoomLevel, setZoomLevel] = useState<1 | 2>(1);
  const [statusText, setStatusText] = useState('');
  const [albumDecoding, setAlbumDecoding] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode>('scan');
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const lastTapAtRef = useRef(0);
  const scannedRef = useRef(false);

  useEffect(() => {
    if (!hasPermission) {
      requestPermission().catch(() => {});
    }
  }, [hasPermission, requestPermission]);

  useFocusEffect(
    useCallback(() => {
      scannedRef.current = false;
      setStatusText('');
      return undefined;
    }, [])
  );

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(scanLineAnim, {
        toValue: 1,
        duration: 1800,
        useNativeDriver: true,
      })
    );
    scanLineAnim.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [scanLineAnim]);

  const lineTranslateY = useMemo(
    () =>
      scanLineAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, Math.max(scanAreaHeight - 2, 1)],
      }),
    [scanAreaHeight, scanLineAnim]
  );

  const effectiveZoom = useMemo(() => {
    if (!device) return 1;
    const target = zoomLevel === 2 ? 2 : 1;
    return Math.max(device.minZoom, Math.min(device.maxZoom, target));
  }, [device, zoomLevel]);
  const effectiveFps = useMemo(() => {
    if (!cameraFormat) return 30;
    return Math.min(60, Math.max(24, cameraFormat.maxFps));
  }, [cameraFormat]);

  const onScanValue = useCallback(
    (value: string) => {
      if (scannedRef.current) return;
      scannedRef.current = true;
      const targetUrl = normalizeScannedUrl(value);
      if (!targetUrl) {
        scannedRef.current = false;
        setStatusText(QR_SCAN_TEXT.invalidScannedValue);
        return;
      }
      navigation.navigate('InAppBrowser', {
        title: QR_SCAN_TEXT.scanResultTitle,
        url: targetUrl,
      });
    },
    [navigation]
  );

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      const first = codes?.[0];
      const value = first?.value ? String(first.value) : '';
      if (!value) return;
      onScanValue(value);
    },
  });

  const onPreviewTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapAtRef.current < 260) {
      setZoomLevel((prev) => (prev === 1 ? 2 : 1));
    }
    lastTapAtRef.current = now;
  }, []);

  const onPressMyQr = useCallback(() => {
    // Reserved button: no navigation behavior by requirement.
  }, []);

  const onSelectMode = useCallback((mode: ScanMode) => {
    setScanMode(mode);
  }, []);

  const onPressAlbum = useCallback(async () => {
    if (albumDecoding) return;
    setAlbumDecoding(true);
    try {
      const picked = await pickQrImageForPlatform();
      if (!picked?.data) return;
      const value = decodeQrFromBase64(picked.data, picked.mime, 'album');
      if (!value) {
        setStatusText(QR_SCAN_TEXT.albumNoQrDetected);
        return;
      }
      onScanValue(value);
    } catch {
      setStatusText(QR_SCAN_TEXT.albumOpenFailed);
    } finally {
      setAlbumDecoding(false);
    }
  }, [albumDecoding, onScanValue]);

  if (!hasPermission) {
    return (
      <View style={[styles.page, styles.center]}>
        <Text style={styles.infoText}>{QR_SCAN_TEXT.cameraPermissionRequired}</Text>
        <Pressable
          style={styles.permissionBtn}
          onPress={() => {
            requestPermission().catch(() => {});
          }}
        >
          <Text style={styles.permissionBtnText}>{QR_SCAN_TEXT.grantCameraPermission}</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.page, styles.center]}>
        <Text style={styles.infoText}>{QR_SCAN_TEXT.noRearCamera}</Text>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <Pressable style={styles.previewArea} onPress={onPreviewTap}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          format={cameraFormat}
          fps={effectiveFps}
          isActive={isFocused && hasPermission}
          zoom={effectiveZoom}
          codeScanner={codeScanner}
          photo={false}
          video={false}
          audio={false}
        />
      </Pressable>

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <BackIcon />
        </Pressable>
      </View>

      <View style={styles.scanMask}>
        <View
          style={styles.scanArea}
          onLayout={(event) => setScanAreaHeight(event.nativeEvent.layout.height)}
        >
          <Animated.View style={[styles.scanLine, { transform: [{ translateY: lineTranslateY }] }]} />
        </View>
        <Text style={styles.tipText}>{QR_SCAN_TEXT.tipAlignCode}</Text>
        <Text style={styles.zoomText}>{`${zoomLevel}x (${QR_SCAN_TEXT.zoomHintDoubleTap})`}</Text>
        {statusText ? <Text style={styles.statusText}>{statusText}</Text> : null}
      </View>

      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <Pressable style={styles.edgeAction} onPress={onPressMyQr}>
          <View style={styles.edgeIconWrap}>
            <MyQrIcon />
          </View>
          <Text style={styles.edgeText}>{QR_SCAN_TEXT.myQrCode}</Text>
        </Pressable>

        <View style={styles.centerTabs}>
          {QR_SCAN_MODE_ITEMS.map((item) => {
            const active = scanMode === item.key;
            return (
              <Pressable
                key={item.key}
                style={styles.centerTabBtn}
                onPress={() => onSelectMode(item.key)}
              >
                <Text
                  style={[
                    styles.modeText,
                    active ? styles.modeTextActive : styles.modeTextInactive,
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable style={styles.edgeAction} onPress={onPressAlbum}>
          <View style={styles.edgeIconWrap}>
            <AlbumIcon />
          </View>
          <Text style={styles.edgeText}>
            {albumDecoding ? QR_SCAN_TEXT.decoding : QR_SCAN_TEXT.album}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#000',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  previewArea: {
    ...StyleSheet.absoluteFillObject,
  },
  topBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanMask: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '15%',
    alignItems: 'center',
  },
  scanArea: {
    width: '88%',
    height: 260,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(7, 45, 89, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(32, 160, 255, 0.35)',
  },
  scanLine: {
    height: 2,
    width: '100%',
    backgroundColor: '#1ea5ff',
    shadowColor: '#1ea5ff',
    shadowOpacity: 0.8,
    shadowRadius: 8,
  },
  tipText: {
    marginTop: 18,
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '500',
  },
  zoomText: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
  },
  statusText: {
    marginTop: 8,
    color: '#ffb6b6',
    fontSize: 12,
    textAlign: 'center',
    maxWidth: '88%',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 116,
    backgroundColor: 'rgba(0,0,0,0.72)',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  edgeAction: {
    width: 86,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 7,
  },
  edgeIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(40, 40, 40, 0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeText: {
    color: '#f1f1f1',
    fontSize: 13,
    lineHeight: 17,
  },
  centerTabs: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    paddingBottom: 2,
  },
  centerTabBtn: {
    minWidth: 56,
    alignItems: 'center',
  },
  modeText: {
    lineHeight: 20,
  },
  modeTextInactive: {
    color: '#a7a7a7',
    fontSize: 16,
    fontWeight: '500',
  },
  modeTextActive: {
    color: '#1ea5ff',
    fontSize: 18,
    fontWeight: '600',
  },
  infoText: {
    color: '#fff',
    fontSize: 16,
  },
  permissionBtn: {
    backgroundColor: '#1ea5ff',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  permissionBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});

function BackIcon() {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#ffffff"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function MyQrIcon() {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill="none">
      <Rect x={4} y={4} width={6} height={6} stroke="#fff" strokeWidth={2} />
      <Rect x={14} y={4} width={6} height={6} stroke="#fff" strokeWidth={2} />
      <Rect x={4} y={14} width={6} height={6} stroke="#fff" strokeWidth={2} />
      <Rect x={15} y={15} width={2} height={2} fill="#fff" />
      <Rect x={18} y={15} width={2} height={2} fill="#fff" />
      <Rect x={15} y={18} width={5} height={2} fill="#fff" />
    </Svg>
  );
}

function AlbumIcon() {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={5} width={18} height={14} rx={2} stroke="#fff" strokeWidth={2} />
      <Circle cx={9} cy={10} r={1.5} fill="#fff" />
      <Path
        d="M5 17L10 12L13 15L16 13L19 17"
        stroke="#fff"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

