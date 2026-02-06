import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { RootNavigation } from '../navigation/types';
import jsQR from 'jsqr';
import { pickQrImageForPlatform } from '../utils/pickQrImage';
import { normalizeScannedUrl } from './qrUtils';
import { QR_SCAN_MODE_ITEMS, QR_SCAN_TEXT, type ScanMode } from './qrScanShared';

type RotationAngle = 0 | 90 | -90 | 180;
type InversionMode = 'dontInvert' | 'attemptBoth';
type DecodeStep = {
  maxSide: number;
  scales: readonly number[];
  angles: readonly RotationAngle[];
  inversion: InversionMode;
};

const DECODE_INTERVAL_MS = 68;
const REALTIME_STEPS: readonly DecodeStep[] = [
  {
    maxSide: 720,
    scales: [1, 0.8],
    angles: [0, 90, -90],
    inversion: 'dontInvert',
  },
  {
    maxSide: 1120,
    scales: [1, 0.86, 0.7],
    angles: [0, 90, -90, 180],
    inversion: 'attemptBoth',
  },
];
const ALBUM_STEPS: readonly DecodeStep[] = [
  {
    maxSide: 960,
    scales: [1, 0.82, 0.66],
    angles: [0, 90, -90],
    inversion: 'attemptBoth',
  },
  {
    maxSide: 1480,
    scales: [1, 0.9, 0.74, 0.58],
    angles: [0, 90, -90, 180],
    inversion: 'attemptBoth',
  },
];

export default function QRScanWeb() {
  const navigation = useNavigation<RootNavigation>();
  const isFocused = useIsFocused();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannedRef = useRef(false);
  const decodeBusyRef = useRef(false);
  const lastTapAtRef = useRef(0);
  const lastDecodeAtRef = useRef(0);

  const [zoomLevel, setZoomLevel] = useState<1 | 2>(1);
  const [statusText, setStatusText] = useState('');
  const [albumDecoding, setAlbumDecoding] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode>('scan');

  const scanFrameStyle = useMemo(
    () => ({
      transform: `scale(${zoomLevel === 2 ? 2 : 1})`,
      transformOrigin: 'center center',
    }),
    [zoomLevel]
  );

  const getWorkCanvas = useCallback(() => {
    if (workCanvasRef.current) return workCanvasRef.current;
    const canvas = document.createElement('canvas');
    workCanvasRef.current = canvas;
    return canvas;
  }, []);

  const stopCamera = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    decodeBusyRef.current = false;
  }, []);

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

  const decodeCurrentCanvas = useCallback(
    (canvas: HTMLCanvasElement, inversion: InversionMode): string => {
      const width = canvas.width;
      const height = canvas.height;
      if (!width || !height) return '';
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return '';
      const imageData = context.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: inversion,
      });
      return code?.data ? String(code.data).trim() : '';
    },
    []
  );

  const drawScaledRotated = useCallback(
    (
      context: CanvasRenderingContext2D,
      source: CanvasImageSource,
      width: number,
      height: number,
      maxSide: number,
      scaleFactor: number,
      angle: RotationAngle
    ) => {
      const baseScale = Math.min(1, maxSide / Math.max(width, height));
      const scale = baseScale * scaleFactor;
      const drawWidth = Math.max(1, Math.round(width * scale));
      const drawHeight = Math.max(1, Math.round(height * scale));

      const rotate90 = angle === 90 || angle === -90;
      context.canvas.width = rotate90 ? drawHeight : drawWidth;
      context.canvas.height = rotate90 ? drawWidth : drawHeight;
      context.save();

      if (angle === 90) {
        context.translate(context.canvas.width, 0);
        context.rotate(Math.PI / 2);
      } else if (angle === -90) {
        context.translate(0, context.canvas.height);
        context.rotate(-Math.PI / 2);
      } else if (angle === 180) {
        context.translate(context.canvas.width, context.canvas.height);
        context.rotate(Math.PI);
      }

      context.drawImage(source, 0, 0, drawWidth, drawHeight);
      context.restore();
    },
    []
  );

  const runDecodePlan = useCallback(
    (source: CanvasImageSource, width: number, height: number, plan: readonly DecodeStep[]) => {
      const workCanvas = getWorkCanvas();
      const context = workCanvas.getContext('2d', { willReadFrequently: true });
      if (!context) return '';

      for (const step of plan) {
        for (const scale of step.scales) {
          for (const angle of step.angles) {
            drawScaledRotated(context, source, width, height, step.maxSide, scale, angle);
            const decoded = decodeCurrentCanvas(workCanvas, step.inversion);
            if (decoded) return decoded;
          }
        }
      }
      return '';
    },
    [decodeCurrentCanvas, drawScaledRotated, getWorkCanvas]
  );

  const decodeLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !isFocused) return;

    const now = Date.now();
    const due = now - lastDecodeAtRef.current >= DECODE_INTERVAL_MS;
    if (!scannedRef.current && due && !decodeBusyRef.current && video.readyState >= 2) {
      decodeBusyRef.current = true;
      lastDecodeAtRef.current = now;
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 480;
      const value = runDecodePlan(video, width, height, REALTIME_STEPS);
      decodeBusyRef.current = false;
      if (value) {
        onScanValue(value);
        return;
      }
    }

    rafRef.current = requestAnimationFrame(decodeLoop);
  }, [isFocused, onScanValue, runDecodePlan]);

  const decodeAlbumImage = useCallback(
    async (dataUrl: string) => {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = dataUrl;
      });
      const width = image.naturalWidth || image.width || 640;
      const height = image.naturalHeight || image.height || 480;
      return runDecodePlan(image, width, height, ALBUM_STEPS);
    },
    [runDecodePlan]
  );

  useEffect(() => {
    if (!isFocused) {
      stopCamera();
      return undefined;
    }

    scannedRef.current = false;
    lastDecodeAtRef.current = 0;
    decodeBusyRef.current = false;
    setStatusText('');
    let cancelled = false;

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        rafRef.current = requestAnimationFrame(decodeLoop);
      } catch (error) {
        const message = error instanceof Error ? error.message : QR_SCAN_TEXT.cameraAccessFailed;
        setStatusText(message || QR_SCAN_TEXT.cameraAccessFailed);
      }
    };

    start().catch(() => undefined);
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [decodeLoop, isFocused, stopCamera]);

  const onPreviewClick = useCallback(() => {
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
      const dataUrl = `data:${picked.mime || 'image/jpeg'};base64,${picked.data}`;
      const value = await decodeAlbumImage(dataUrl);
      if (!value) {
        setStatusText(QR_SCAN_TEXT.albumNoQrDetected);
        return;
      }
      onScanValue(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : QR_SCAN_TEXT.albumOpenFailed;
      setStatusText(message);
    } finally {
      setAlbumDecoding(false);
    }
  }, [albumDecoding, decodeAlbumImage, onScanValue]);

  return (
    <div style={styles.page}>
      <div style={styles.previewWrap} onClick={onPreviewClick}>
        <video ref={videoRef} playsInline muted style={{ ...styles.video, ...scanFrameStyle }} />
      </div>
      <canvas ref={canvasRef} style={styles.hiddenCanvas} />

      <div style={styles.topBar}>
        <button type="button" style={styles.backBtn} onClick={() => navigation.goBack()}>
          <BackIcon />
        </button>
      </div>

      <div style={styles.scanMask}>
        <div style={styles.scanArea}>
          <div style={styles.scanLine} />
        </div>
        <div style={styles.tipText}>{QR_SCAN_TEXT.tipAlignCode}</div>
        <div style={styles.zoomText}>{`${zoomLevel}x (${QR_SCAN_TEXT.zoomHintDoubleTap})`}</div>
        {statusText ? <div style={styles.errorText}>{statusText}</div> : null}
      </div>

      <div style={styles.bottomBar}>
        <button type="button" style={styles.edgeAction} onClick={onPressMyQr}>
          <div style={styles.edgeIconWrap}>
            <MyQrIcon />
          </div>
          <div style={styles.edgeText}>{QR_SCAN_TEXT.myQrCode}</div>
        </button>

        <div style={styles.centerTabs}>
          {QR_SCAN_MODE_ITEMS.map((item) => {
            const active = scanMode === item.key;
            return (
              <button
                key={item.key}
                type="button"
                style={{
                  ...styles.centerTabBtn,
                  ...(active ? styles.centerTabBtnActive : styles.centerTabBtnInactive),
                }}
                onClick={() => onSelectMode(item.key)}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <button type="button" style={styles.edgeAction} onClick={onPressAlbum}>
          <div style={styles.edgeIconWrap}>
            <AlbumIcon />
          </div>
          <div style={styles.edgeText}>
            {albumDecoding ? QR_SCAN_TEXT.decoding : QR_SCAN_TEXT.album}
          </div>
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: '100vh',
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  previewWrap: {
    position: 'absolute',
    inset: 0,
    cursor: 'pointer',
    overflow: 'hidden',
    touchAction: 'manipulation',
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  topBar: {
    position: 'absolute',
    left: 12,
    top: 12,
    zIndex: 20,
  },
  backBtn: {
    width: 36,
    height: 36,
    border: 0,
    borderRadius: 18,
    background: 'rgba(0, 0, 0, 0.35)',
    color: '#fff',
    cursor: 'pointer',
  },
  scanMask: {
    position: 'absolute',
    top: '15%',
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    zIndex: 10,
    flexDirection: 'column',
  },
  scanArea: {
    width: '88%',
    height: 260,
    borderRadius: 10,
    overflow: 'hidden',
    background: 'rgba(7, 45, 89, 0.12)',
    border: '1px solid rgba(32, 160, 255, 0.35)',
    position: 'relative',
  },
  scanLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    background: '#1ea5ff',
    boxShadow: '0 0 12px #1ea5ff',
    animation: 'xinchat-scanline 1.8s linear infinite',
  },
  tipText: {
    marginTop: 18,
    color: '#fff',
    fontSize: 17,
    fontWeight: 500,
  },
  zoomText: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
  },
  errorText: {
    marginTop: 10,
    color: '#ffb6b6',
    fontSize: 13,
    textAlign: 'center',
    maxWidth: '88%',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 116,
    padding: '8px 14px 10px',
    background: 'rgba(0, 0, 0, 0.72)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    flexDirection: 'row',
    zIndex: 11,
  },
  centerTabs: {
    flex: 1,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    paddingBottom: 2,
  },
  centerTabBtn: {
    border: 0,
    background: 'transparent',
    padding: 0,
    minWidth: 56,
    cursor: 'pointer',
    lineHeight: '20px',
    fontWeight: 500,
  },
  centerTabBtnInactive: {
    color: '#a7a7a7',
    fontSize: 16,
  },
  centerTabBtnActive: {
    color: '#1ea5ff',
    fontSize: 18,
    fontWeight: 600,
  },
  edgeAction: {
    width: 86,
    border: 0,
    background: 'transparent',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 7,
    padding: 0,
  },
  edgeIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    background: 'rgba(40, 40, 40, 0.88)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  edgeText: {
    color: '#f1f1f1',
    fontSize: 13,
    lineHeight: '17px',
  },
  hiddenCanvas: {
    display: 'none',
  },
};

function MyQrIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path d="M4 4h6v6H4V4ZM14 4h6v6h-6V4ZM4 14h6v6H4v-6Z" stroke="#fff" strokeWidth="2" />
      <path d="M15 15h2v2h-2v-2ZM18 15h2v2h-2v-2ZM15 18h5v2h-5v-2Z" fill="#fff" />
    </svg>
  );
}

function AlbumIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="#fff" strokeWidth="2" />
      <circle cx="9" cy="10" r="1.5" fill="#fff" />
      <path
        d="M5 17l5-5 3 3 3-2 3 4"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M15 18L9 12L15 6"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

if (typeof document !== 'undefined') {
  const styleId = 'xinchat-scanline-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes xinchat-scanline {
        0% { transform: translateY(0); }
        100% { transform: translateY(258px); }
      }
    `;
    document.head.appendChild(style);
  }
}

