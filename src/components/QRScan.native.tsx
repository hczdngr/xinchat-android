import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native';
import type { RootNavigation } from '../navigation/types';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Buffer } from 'buffer';
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
import { API_BASE } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { storage } from '../storage';
import {
  normalizeObjectDetectPayload,
  type ObjectDetectItem,
  type ObjectDetectPayload,
} from '../utils/objectDetectNormalize';
import { normalizeScannedUrl } from './qrUtils';
import { QR_SCAN_MODE_ITEMS, QR_SCAN_TEXT, type ScanMode } from './qrScanShared';

const normalizeBase64 = (value: string) => String(value || '').replace(/\s+/g, '');
const toFileUri = (value: string) => {
  const path = String(value || '').trim();
  if (!path) return '';
  return path.startsWith('file://') ? path : `file://${path}`;
};

const filePathToBase64 = async (rawPath: string) => {
  const uri = rawPath.startsWith('file://') ? rawPath : `file://${rawPath}`;
  const response = await fetch(uri);
  if (!response.ok) throw new Error('Read photo failed');
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('base64');
};


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
  const [arRecognizing, setArRecognizing] = useState(false);
  const [arSummary, setArSummary] = useState('');
  const [arScene, setArScene] = useState('');
  const [arObjects, setArObjects] = useState<ObjectDetectItem[]>([]);
  const [scanMode, setScanMode] = useState<ScanMode>('scan');
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const techSpinAnim = useRef(new Animated.Value(0)).current;
  const techPulseAnim = useRef(new Animated.Value(0)).current;
  const lastTapAtRef = useRef(0);
  const scannedRef = useRef(false);
  const cameraRef = useRef<Camera>(null);
  const arPending = arRecognizing || (scanMode === 'ar' && albumDecoding);

  useEffect(() => {
    if (!hasPermission) {
      requestPermission().catch(() => {});
    }
  }, [hasPermission, requestPermission]);

  useFocusEffect(
    useCallback(() => {
      scannedRef.current = false;
      setStatusText('');
      setArSummary('');
      setArScene('');
      setArObjects([]);
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

  useEffect(() => {
    if (!arPending) {
      techSpinAnim.stopAnimation();
      techPulseAnim.stopAnimation();
      techSpinAnim.setValue(0);
      techPulseAnim.setValue(0);
      return undefined;
    }
    const spinLoop = Animated.loop(
      Animated.timing(techSpinAnim, {
        toValue: 1,
        duration: 2200,
        useNativeDriver: true,
      })
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(techPulseAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(techPulseAnim, {
          toValue: 0,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    );
    spinLoop.start();
    pulseLoop.start();
    return () => {
      spinLoop.stop();
      pulseLoop.stop();
    };
  }, [arPending, techPulseAnim, techSpinAnim]);

  const lineTranslateY = useMemo(
    () =>
      scanLineAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, Math.max(scanAreaHeight - 2, 1)],
      }),
    [scanAreaHeight, scanLineAnim]
  );
  const techRotate = useMemo(
    () =>
      techSpinAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
      }),
    [techSpinAnim]
  );
  const techRotateReverse = useMemo(
    () =>
      techSpinAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ['360deg', '0deg'],
      }),
    [techSpinAnim]
  );
  const techSweepTranslateX = useMemo(
    () =>
      techSpinAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [-120, 120],
      }),
    [techSpinAnim]
  );
  const techPulseScale = useMemo(
    () =>
      techPulseAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.86, 1.24],
      }),
    [techPulseAnim]
  );
  const techPulseOpacity = useMemo(
    () =>
      techPulseAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.32, 0.68],
      }),
    [techPulseAnim]
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

  const detectObjects = useCallback(async (mimeType: string, base64: string) => {
    const token = (await storage.getString(STORAGE_KEYS.token)) || '';
    if (!token) throw new Error('No auth token');

    const response = await fetch(`${API_BASE}/api/insight/object-detect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        image: `data:${mimeType};base64,${normalizeBase64(base64)}`,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.data) {
      throw new Error(String(data?.message || QR_SCAN_TEXT.arRecognizeFailed));
    }
    return normalizeObjectDetectPayload(data.data);
  }, []);

  const applyArResult = useCallback((rawResult: ObjectDetectPayload) => {
    const result = normalizeObjectDetectPayload(rawResult);
    const summary = String(result.summary || '').trim();
    const scene = String(result.scene || '').trim();
    const objects = Array.isArray(result.objects) ? result.objects : [];
    setArSummary(summary);
    setArScene(scene);
    setArObjects(objects);
    if (!summary && objects.length === 0) {
      setStatusText(QR_SCAN_TEXT.albumNoObjectDetected);
      return;
    }
    setStatusText('');
  }, []);

  const buildInsightQuery = useCallback((rawResult: ObjectDetectPayload) => {
    const result = normalizeObjectDetectPayload(rawResult);
    const firstObjectName = (Array.isArray(result.objects) ? result.objects : [])
      .map((item) => String(item?.name || '').trim())
      .find(Boolean);
    if (firstObjectName) return firstObjectName;
    const summary = String(result.summary || '').replace(/\s+/g, ' ').trim();
    if (!summary) return '';
    return summary.replace(/[。！？.!?].*$/, '').slice(0, 48).trim();
  }, []);

  const openInsightPage = useCallback(
    (rawResult: ObjectDetectPayload, imageUri: string) => {
      const result = normalizeObjectDetectPayload(rawResult);
      const query = buildInsightQuery(result);
      if (!query) {
        setStatusText(QR_SCAN_TEXT.albumNoObjectDetected);
        return;
      }
      navigation.navigate('ObjectInsight', {
        query,
        imageUri: String(imageUri || '').trim(),
        detectSummary: String(result.summary || ''),
        detectScene: String(result.scene || ''),
        detectObjects: Array.isArray(result.objects) ? result.objects : [],
      });
    },
    [buildInsightQuery, navigation]
  );

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      if (scanMode !== 'scan') return;
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
    if (mode === scanMode) return;
    setScanMode(mode);
    setStatusText('');
    setArSummary('');
    setArScene('');
    setArObjects([]);
    if (mode === 'scan') {
      scannedRef.current = false;
    }
  }, [scanMode]);

  const onPressArCapture = useCallback(async () => {
    if (scanMode !== 'ar' || arRecognizing) return;
    setArRecognizing(true);
    setStatusText(QR_SCAN_TEXT.arRecognizing);
    try {
      const camera = cameraRef.current;
      if (!camera) {
        setStatusText(QR_SCAN_TEXT.arNoFrame);
        return;
      }
      const captured = await camera.takePhoto({
        enableShutterSound: false,
      });
      const path = String(captured?.path || '').trim();
      if (!path) throw new Error(QR_SCAN_TEXT.arCaptureFailed);
      const base64 = await filePathToBase64(path);
      const mimeType = path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const result = await detectObjects(mimeType, base64);
      applyArResult(result);
      openInsightPage(result, toFileUri(path));
    } catch (error) {
      const message = error instanceof Error ? error.message : QR_SCAN_TEXT.arCaptureFailed;
      setStatusText(message || QR_SCAN_TEXT.arCaptureFailed);
    } finally {
      setArRecognizing(false);
    }
  }, [applyArResult, arRecognizing, detectObjects, openInsightPage, scanMode]);

  const onPressAlbum = useCallback(async () => {
    if (albumDecoding) return;
    setAlbumDecoding(true);
    try {
      const picked = await pickQrImageForPlatform();
      if (!picked?.data) return;
      if (scanMode === 'ar') {
        setStatusText(QR_SCAN_TEXT.arRecognizing);
        const result = await detectObjects(picked.mime || 'image/jpeg', picked.data);
        applyArResult(result);
        openInsightPage(result, toFileUri(picked.path));
      } else {
        const value = decodeQrFromBase64(picked.data, picked.mime, 'album');
        if (!value) {
          setStatusText(QR_SCAN_TEXT.albumNoQrDetected);
          return;
        }
        onScanValue(value);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : QR_SCAN_TEXT.albumOpenFailed;
      setStatusText(message || QR_SCAN_TEXT.albumOpenFailed);
    } finally {
      setAlbumDecoding(false);
    }
  }, [albumDecoding, applyArResult, detectObjects, onScanValue, openInsightPage, scanMode]);

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
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          format={cameraFormat}
          fps={effectiveFps}
          isActive={isFocused && hasPermission}
          zoom={effectiveZoom}
          codeScanner={scanMode === 'scan' ? codeScanner : undefined}
          photo
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
          {scanMode === 'scan' ? (
            <Animated.View style={[styles.scanLine, { transform: [{ translateY: lineTranslateY }] }]} />
          ) : null}
        </View>
        <Text style={styles.tipText}>
          {scanMode === 'ar' ? QR_SCAN_TEXT.tipAlignObject : QR_SCAN_TEXT.tipAlignCode}
        </Text>
        <Text style={styles.zoomText}>{`${zoomLevel}x (${QR_SCAN_TEXT.zoomHintDoubleTap})`}</Text>
        {scanMode === 'ar' ? (
          <Pressable
            style={[styles.arActionBtn, arRecognizing && styles.arActionBtnDisabled]}
            onPress={onPressArCapture}
            disabled={arRecognizing}
          >
            <Text style={styles.arActionText}>
              {arRecognizing ? QR_SCAN_TEXT.arRecognizing : QR_SCAN_TEXT.arRecognizeButton}
            </Text>
          </Pressable>
        ) : null}
        {statusText ? <Text style={styles.statusText}>{statusText}</Text> : null}
        {scanMode === 'ar' && (arSummary || arObjects.length > 0) ? (
          <View style={styles.arResultCard}>
            <Text style={styles.arResultTitle}>{QR_SCAN_TEXT.arResultTitle}</Text>
            {arSummary ? <Text style={styles.arResultSummary}>{arSummary}</Text> : null}
            {arScene ? <Text style={styles.arResultScene}>{`场景：${arScene}`}</Text> : null}
            {arObjects.slice(0, 4).map((item, index) => {
              const confidence = Number(item?.confidence);
              const percent = Number.isFinite(confidence) ? Math.round(confidence * 100) : 0;
              const suffix = percent >= 1 && percent <= 100 ? ` (${percent}%)` : '';
              return (
                <Text key={`ar-obj-${index}-${item?.name || 'unknown'}`} style={styles.arObjectItem}>
                  {`\u2022 ${item?.name || '未知物体'}${suffix}`}
                </Text>
              );
            })}
          </View>
        ) : null}
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
            {albumDecoding
              ? QR_SCAN_TEXT.decoding
              : scanMode === 'ar'
                ? QR_SCAN_TEXT.albumRecognize
                : QR_SCAN_TEXT.album}
          </Text>
        </Pressable>
      </View>

      {arPending ? (
        <View style={styles.pendingOverlay} pointerEvents="auto">
          <View style={styles.pendingGrid} />
          <View style={styles.pendingVignette} />
          <View style={styles.pendingCenterWrap}>
            <View style={styles.pendingRadar}>
              <Animated.View
                style={[
                  styles.pendingPulse,
                  {
                    opacity: techPulseOpacity,
                    transform: [{ scale: techPulseScale }],
                  },
                ]}
              />
              <Animated.View
                style={[
                  styles.pendingRingOuter,
                  {
                    transform: [{ rotate: techRotate }],
                  },
                ]}
              />
              <Animated.View
                style={[
                  styles.pendingRingInner,
                  {
                    transform: [{ rotate: techRotateReverse }],
                  },
                ]}
              />
              <Animated.View
                style={[
                  styles.pendingSweep,
                  {
                    transform: [{ translateX: techSweepTranslateX }, { rotate: '25deg' }],
                  },
                ]}
              />
              <View style={styles.pendingCore} />
            </View>
            <Text style={styles.pendingTitle}>AI Vision Scanning</Text>
            <Text style={styles.pendingSubtitle}>{QR_SCAN_TEXT.arRecognizing}</Text>
          </View>
        </View>
      ) : null}
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
  arActionBtn: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(31, 166, 255, 0.8)',
    backgroundColor: 'rgba(31, 166, 255, 0.2)',
  },
  arActionBtnDisabled: {
    opacity: 0.65,
  },
  arActionText: {
    color: '#cdeeff',
    fontSize: 13,
    fontWeight: '600',
  },
  arResultCard: {
    marginTop: 12,
    width: '88%',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(150, 206, 255, 0.35)',
    backgroundColor: 'rgba(0, 21, 42, 0.72)',
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  arResultTitle: {
    color: '#d3ecff',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 5,
  },
  arResultSummary: {
    color: '#e9f5ff',
    fontSize: 12,
    lineHeight: 17,
  },
  arResultScene: {
    marginTop: 4,
    color: '#b9dfff',
    fontSize: 11,
  },
  arObjectItem: {
    marginTop: 3,
    color: '#cce8ff',
    fontSize: 11,
    lineHeight: 15,
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
  pendingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    backgroundColor: 'rgba(3, 10, 20, 0.84)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingGrid: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(16, 63, 112, 0.14)',
  },
  pendingVignette: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.34)',
  },
  pendingCenterWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  pendingRadar: {
    width: 196,
    height: 196,
    borderRadius: 98,
    borderWidth: 1,
    borderColor: 'rgba(111, 194, 255, 0.42)',
    backgroundColor: 'rgba(7, 28, 53, 0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  pendingPulse: {
    position: 'absolute',
    width: 176,
    height: 176,
    borderRadius: 88,
    borderWidth: 1,
    borderColor: 'rgba(99, 202, 255, 0.7)',
    backgroundColor: 'rgba(79, 169, 255, 0.08)',
  },
  pendingRingOuter: {
    position: 'absolute',
    width: 162,
    height: 162,
    borderRadius: 81,
    borderWidth: 2,
    borderColor: 'rgba(94, 211, 255, 0.86)',
    borderStyle: 'dashed',
  },
  pendingRingInner: {
    position: 'absolute',
    width: 122,
    height: 122,
    borderRadius: 61,
    borderWidth: 1,
    borderColor: 'rgba(110, 169, 255, 0.76)',
    borderStyle: 'dashed',
  },
  pendingSweep: {
    position: 'absolute',
    width: 120,
    height: 200,
    backgroundColor: 'rgba(109, 226, 255, 0.13)',
  },
  pendingCore: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#8ddfff',
    borderWidth: 1,
    borderColor: 'rgba(219, 246, 255, 0.95)',
    shadowColor: '#6ed6ff',
    shadowOpacity: 0.75,
    shadowRadius: 14,
    elevation: 8,
  },
  pendingTitle: {
    marginTop: 8,
    color: '#bdeeff',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  pendingSubtitle: {
    color: '#8cc7e8',
    fontSize: 13,
    letterSpacing: 0.4,
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

