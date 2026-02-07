import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API_BASE, normalizeImageUrl } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { storage } from '../storage';
import { pickImageForPlatform, type PickedImage } from '../utils/pickImage';
import { cropImageForPlatform } from '../utils/cropImage';
import * as isoCountries from 'i18n-iso-countries';
import zhLocale from 'i18n-iso-countries/langs/zh.json';

type ProfileData = {
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
};

type Props = {
  onBack: () => void;
  onSaved?: (profile: ProfileData) => void;
  initialProfile?: ProfileData;
};

const CHINA = '\u4e2d\u56fd';
const GENDER_OPTIONS = ['\u7537', '\u5973', '\u5176\u4ed6'];
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const YEAR_OPTIONS = Array.from({ length: 90 }, (_, i) => String(new Date().getFullYear() - i));
const AVATAR_OUTPUT_SIZE = 512;
const AVATAR_SQUARE_TOLERANCE = 1;
const AVATAR_MIN_ZOOM = 1;
const AVATAR_MAX_ZOOM = 3;
const AVATAR_ZOOM_STEP = 0.12;
const DAY_OPTIONS = (year: number, month: number) => {
  const count = new Date(year, month, 0).getDate();
  return Array.from({ length: count }, (_, i) => String(i + 1).padStart(2, '0'));
};

type AvatarCropState = {
  mime: string;
  data: string;
  width: number;
  height: number;
  frameSize: number;
  baseDisplayWidth: number;
  baseDisplayHeight: number;
  displayWidth: number;
  displayHeight: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
};

const isSquareImage = (width: number, height: number) =>
  width > 0 && height > 0 && Math.abs(width - height) <= AVATAR_SQUARE_TOLERANCE;

const clampAvatarCropOffset = (
  displayWidth: number,
  displayHeight: number,
  frameSize: number,
  nextX: number,
  nextY: number
) => {
  const maxOffsetX = Math.max(0, (displayWidth - frameSize) / 2);
  const maxOffsetY = Math.max(0, (displayHeight - frameSize) / 2);
  return {
    x: Math.max(-maxOffsetX, Math.min(maxOffsetX, nextX)),
    y: Math.max(-maxOffsetY, Math.min(maxOffsetY, nextY)),
  };
};

const clampAvatarZoom = (value: number) =>
  Math.max(AVATAR_MIN_ZOOM, Math.min(AVATAR_MAX_ZOOM, value));

const applyAvatarCropZoom = (state: AvatarCropState, nextZoomRaw: number) => {
  const nextZoom = clampAvatarZoom(nextZoomRaw);
  const nextDisplayWidth = state.baseDisplayWidth * nextZoom;
  const nextDisplayHeight = state.baseDisplayHeight * nextZoom;
  const clamped = clampAvatarCropOffset(
    nextDisplayWidth,
    nextDisplayHeight,
    state.frameSize,
    state.offsetX,
    state.offsetY
  );
  return {
    ...state,
    zoom: nextZoom,
    displayWidth: nextDisplayWidth,
    displayHeight: nextDisplayHeight,
    offsetX: clamped.x,
    offsetY: clamped.y,
  };
};

const getTouchDistance = (touchA: { pageX: number; pageY: number }, touchB: { pageX: number; pageY: number }) => {
  const dx = touchA.pageX - touchB.pageX;
  const dy = touchA.pageY - touchB.pageY;
  return Math.sqrt(dx * dx + dy * dy);
};

isoCountries.registerLocale(zhLocale as any);
const EXCLUDED_COUNTRY_KEYWORDS = ['\u9999\u6e2f', '\u6fb3\u95e8', '\u53f0\u6e7e'];
const COUNTRIES = Array.from(
  new Set(Object.values(isoCountries.getNames('zh', { select: 'official' })))
)
  .filter((name) => !EXCLUDED_COUNTRY_KEYWORDS.some((kw) => name.includes(kw)))
  .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));


const CHINA_PROVINCES = [
  '\u5317\u4eac\u5e02',
  '\u5929\u6d25\u5e02',
  '\u4e0a\u6d77\u5e02',
  '\u91cd\u5e86\u5e02',
  '\u6cb3\u5317\u7701',
  '\u5c71\u897f\u7701',
  '\u8fbd\u5b81\u7701',
  '\u5409\u6797\u7701',
  '\u9ed1\u9f99\u6c5f\u7701',
  '\u6c5f\u82cf\u7701',
  '\u6d59\u6c5f\u7701',
  '\u5b89\u5fbd\u7701',
  '\u798f\u5efa\u7701',
  '\u6c5f\u897f\u7701',
  '\u5c71\u4e1c\u7701',
  '\u6cb3\u5357\u7701',
  '\u6e56\u5317\u7701',
  '\u6e56\u5357\u7701',
  '\u5e7f\u4e1c\u7701',
  '\u6d77\u5357\u7701',
  '\u56db\u5ddd\u7701',
  '\u8d35\u5dde\u7701',
  '\u4e91\u5357\u7701',
  '\u9655\u897f\u7701',
  '\u7518\u8083\u7701',
  '\u9752\u6d77\u7701',
  '\u5185\u8499\u53e4\u81ea\u6cbb\u533a',
  '\u5e7f\u897f\u58ee\u65cf\u81ea\u6cbb\u533a',
  '\u897f\u85cf\u81ea\u6cbb\u533a',
  '\u5b81\u590f\u56de\u65cf\u81ea\u6cbb\u533a',
  '\u65b0\u7586\u7ef4\u543e\u5c14\u81ea\u6cbb\u533a',
];

const CHINA_CITIES: Record<string, string[]> = {
  '\u5317\u4eac\u5e02': ['\u5317\u4eac\u5e02'],
  '\u5929\u6d25\u5e02': ['\u5929\u6d25\u5e02'],
  '\u4e0a\u6d77\u5e02': ['\u4e0a\u6d77\u5e02'],
  '\u91cd\u5e86\u5e02': ['\u91cd\u5e86\u5e02'],
  '\u6cb3\u5317\u7701': ['\u77f3\u5bb6\u5e84'],
  '\u5c71\u897f\u7701': ['\u592a\u539f'],
  '\u8fbd\u5b81\u7701': ['\u6c88\u9633'],
  '\u5409\u6797\u7701': ['\u957f\u6625'],
  '\u9ed1\u9f99\u6c5f\u7701': ['\u54c8\u5c14\u6ee8'],
  '\u6c5f\u82cf\u7701': ['\u5357\u4eac'],
  '\u6d59\u6c5f\u7701': ['\u676d\u5dde'],
  '\u5b89\u5fbd\u7701': ['\u5408\u80a5'],
  '\u798f\u5efa\u7701': ['\u798f\u5dde'],
  '\u6c5f\u897f\u7701': ['\u5357\u660c'],
  '\u5c71\u4e1c\u7701': ['\u6d4e\u5357'],
  '\u6cb3\u5357\u7701': ['\u90d1\u5dde'],
  '\u6e56\u5317\u7701': ['\u6b66\u6c49'],
  '\u6e56\u5357\u7701': ['\u957f\u6c99'],
  '\u5e7f\u4e1c\u7701': ['\u5e7f\u5dde'],
  '\u6d77\u5357\u7701': ['\u6d77\u53e3'],
  '\u56db\u5ddd\u7701': ['\u6210\u90fd'],
  '\u8d35\u5dde\u7701': ['\u8d35\u9633'],
  '\u4e91\u5357\u7701': ['\u6606\u660e'],
  '\u9655\u897f\u7701': ['\u897f\u5b89'],
  '\u7518\u8083\u7701': ['\u5170\u5dde'],
  '\u9752\u6d77\u7701': ['\u897f\u5b81'],
  '\u5185\u8499\u53e4\u81ea\u6cbb\u533a': ['\u547c\u548c\u6d69\u7279'],
  '\u5e7f\u897f\u58ee\u65cf\u81ea\u6cbb\u533a': ['\u5357\u5b81'],
  '\u897f\u85cf\u81ea\u6cbb\u533a': ['\u62c9\u8428'],
  '\u5b81\u590f\u56de\u65cf\u81ea\u6cbb\u533a': ['\u94f6\u5ddd'],
  '\u65b0\u7586\u7ef4\u543e\u5c14\u81ea\u6cbb\u533a': ['\u4e4c\u9c81\u6728\u9f50'],
};

export default function EditProfile({ onBack, onSaved, initialProfile }: Props) {
  const insets = useSafeAreaInsets();
  const appear = useRef(new Animated.Value(0)).current;
  const isLeaving = useRef(false);
  const [profile, setProfile] = useState<ProfileData>(initialProfile || {});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [countryOpen, setCountryOpen] = useState(false);
  const [provinceOpen, setProvinceOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [genderOpen, setGenderOpen] = useState(false);
  const [birthdayOpen, setBirthdayOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [birthdayYear, setBirthdayYear] = useState('');
  const [birthdayMonth, setBirthdayMonth] = useState('');
  const [birthdayDay, setBirthdayDay] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [pickerActive, setPickerActive] = useState(false);
  const [avatarCrop, setAvatarCrop] = useState<AvatarCropState | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const avatarCropRef = useRef<AvatarCropState | null>(null);
  const cropResolveRef = useRef<((base64: string | null) => void) | null>(null);
  const cropPanStartRef = useRef({ x: 0, y: 0 });
  const cropGestureModeRef = useRef<'none' | 'drag' | 'pinch'>('none');
  const cropPinchStartDistanceRef = useRef(0);
  const cropPinchStartZoomRef = useRef(1);
  const avatarUrl = useMemo(() => normalizeImageUrl(profile.avatar), [profile.avatar]);
  const avatarVersion = useMemo(() => {
    const clean = avatarUrl.split('?')[0].replace(/\/+$/, '');
    const name = clean.split('/').pop();
    return name || String(profile.avatar || '1');
  }, [avatarUrl, profile.avatar]);
  const avatarSrc = useMemo(() => {
    if (!avatarUrl) return '';
    if (avatarUrl.startsWith('data:')) return avatarUrl;
    const joiner = avatarUrl.includes('?') ? '&' : '?';
    return encodeURI(`${avatarUrl}${joiner}v=${encodeURIComponent(avatarVersion)}`);
  }, [avatarUrl, avatarVersion]);
  const isModalOpen = countryOpen || provinceOpen || cityOpen || genderOpen || birthdayOpen;
  const allowGestures = !isModalOpen && !pickerActive && !avatarCrop;

  const closeAllModals = useCallback(() => {
    setCountryOpen(false);
    setProvinceOpen(false);
    setCityOpen(false);
    setGenderOpen(false);
    setBirthdayOpen(false);
  }, []);

  const runExit = useCallback(() => {
    if (isLeaving.current) return;
    isLeaving.current = true;
    Animated.timing(appear, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      onBack();
    });
  }, [appear, onBack]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const { width } = Dimensions.get('window');
        const edgeSize = 20;
        const x = evt.nativeEvent.pageX;
        const isEdge = x <= edgeSize || x >= width - edgeSize;
        return isEdge && Math.abs(gestureState.dx) > 12 && Math.abs(gestureState.dy) < 24;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (Math.abs(gestureState.dx) >= 30) {
          runExit();
        }
      },
    })
  ).current;

  const cropPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => Boolean(avatarCropRef.current),
      onMoveShouldSetPanResponder: () => Boolean(avatarCropRef.current),
      onStartShouldSetPanResponderCapture: () => Boolean(avatarCropRef.current),
      onMoveShouldSetPanResponderCapture: () => Boolean(avatarCropRef.current),
      onPanResponderGrant: (evt) => {
        const current = avatarCropRef.current;
        const touches = (evt?.nativeEvent?.touches || []) as Array<{ pageX: number; pageY: number }>;
        if (touches.length >= 2 && current) {
          cropGestureModeRef.current = 'pinch';
          cropPinchStartDistanceRef.current = getTouchDistance(touches[0], touches[1]);
          cropPinchStartZoomRef.current = current.zoom;
          return;
        }
        cropGestureModeRef.current = 'drag';
        cropPanStartRef.current = {
          x: current?.offsetX || 0,
          y: current?.offsetY || 0,
        };
      },
      onPanResponderMove: (evt, gestureState) => {
        if (cropGestureModeRef.current === 'pinch') {
          const touches = (evt?.nativeEvent?.touches || []) as Array<{ pageX: number; pageY: number }>;
          if (touches.length >= 2) {
            const distance = getTouchDistance(touches[0], touches[1]);
            if (distance > 0 && cropPinchStartDistanceRef.current > 0) {
              const ratio = distance / cropPinchStartDistanceRef.current;
              const nextZoom = cropPinchStartZoomRef.current * ratio;
              setAvatarCrop((prev) => (prev ? applyAvatarCropZoom(prev, nextZoom) : prev));
            }
          }
          return;
        }
        if (cropGestureModeRef.current !== 'drag') return;
        setAvatarCrop((prev) => {
          if (!prev) return prev;
          const nextX = cropPanStartRef.current.x + gestureState.dx;
          const nextY = cropPanStartRef.current.y + gestureState.dy;
          const clamped = clampAvatarCropOffset(
            prev.displayWidth,
            prev.displayHeight,
            prev.frameSize,
            nextX,
            nextY
          );
          return {
            ...prev,
            offsetX: clamped.x,
            offsetY: clamped.y,
          };
        });
      },
      onPanResponderRelease: () => {
        cropGestureModeRef.current = 'none';
      },
      onPanResponderTerminate: () => {
        cropGestureModeRef.current = 'none';
      },
    })
  ).current;

  useEffect(() => {
    Animated.timing(appear, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [appear]);

  useEffect(() => {
    avatarCropRef.current = avatarCrop;
  }, [avatarCrop]);

  useEffect(() => {
    const handler = () => {
      if (avatarCrop) {
        setAvatarCrop(null);
        cropResolveRef.current?.(null);
        cropResolveRef.current = null;
        return true;
      }
      if (pickerActive) return true;
      if (isModalOpen) {
        closeAllModals();
        return true;
      }
      runExit();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => sub.remove();
  }, [avatarCrop, closeAllModals, isModalOpen, pickerActive, runExit]);

  useEffect(
    () => () => {
      cropResolveRef.current?.(null);
      cropResolveRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const doc = (globalThis as any).document as Document | undefined;
    const bodyStyle = doc?.body?.style;
    if (!bodyStyle || !avatarCrop) return;
    const previousOverflow = bodyStyle.overflow;
    const previousTouchAction = (bodyStyle as any).touchAction;
    bodyStyle.overflow = 'hidden';
    (bodyStyle as any).touchAction = 'none';
    return () => {
      bodyStyle.overflow = previousOverflow;
      (bodyStyle as any).touchAction = previousTouchAction;
    };
  }, [avatarCrop]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  useEffect(() => {
    if (!avatarSrc || avatarSrc.startsWith('data:')) return;
    Image.getSize(
      avatarSrc,
      () => setAvatarFailed(false),
      () => setAvatarFailed(true)
    );
  }, [avatarSrc]);

  useEffect(() => {
    if (initialProfile) {
      setProfile((prev) => ({ ...initialProfile, ...prev }));
    }
  }, [initialProfile]);

  useEffect(() => {
    const loadProfile = async () => {
      setLoading(true);
      setError('');
      try {
        const token = await storage.getString(STORAGE_KEYS.token);
        const response = await fetch(`${API_BASE}/api/profile`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && data?.user) {
          setProfile(data.user);
        } else {
          setError(data?.message || '\u52a0\u8f7d\u8d44\u6599\u5931\u8d25\u3002');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError('\u7f51\u7edc\u9519\u8bef\uff1a' + message);
      } finally {
        setLoading(false);
      }
    };
    loadProfile().catch(() => undefined);
  }, []);

  const updateField = useCallback((key: keyof ProfileData, value: string) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
  }, []);

  const isChina = useMemo(() => profile.country === CHINA, [profile.country]);
  const provinceOptions = useMemo(() => (isChina ? CHINA_PROVINCES : []), [isChina]);
  const cityOptions = useMemo(() => {
    if (!isChina || !profile.province) return [];
    return CHINA_CITIES[profile.province] || [];
  }, [isChina, profile.province]);

  useEffect(() => {
    if (!isChina) {
      setProfile((prev) => ({ ...prev, province: '', region: '' }));
    }
  }, [isChina]);

  useEffect(() => {
    if (isChina && profile.province) {
      if (!cityOptions.includes(profile.region || '')) {
        setProfile((prev) => ({ ...prev, region: '' }));
      }
    }
  }, [cityOptions, isChina, profile.province, profile.region]);

  const canSave = useMemo(() => !saving && !loading, [loading, saving]);

  const persistProfile = useCallback(
    async (override?: Partial<ProfileData>) => {
      if (saving) return false;
      setSaving(true);
      setError('');
      setStatus('\u4fdd\u5b58\u4e2d...');
      try {
    const token = await storage.getString(STORAGE_KEYS.token);
        const payload = {
          nickname: override?.nickname ?? profile.nickname ?? '',
          signature: override?.signature ?? profile.signature ?? '',
          gender: override?.gender ?? profile.gender ?? '',
          birthday: override?.birthday ?? profile.birthday ?? '',
          country: override?.country ?? profile.country ?? '',
          province: override?.province ?? profile.province ?? '',
          region: override?.region ?? profile.region ?? '',
          avatar: override?.avatar ?? profile.avatar ?? '',
        };
        const response = await fetch(`${API_BASE}/api/profile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
          setError(data?.message || '\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002');
          scrollRef.current?.scrollTo({ y: 0, animated: true });
          return false;
        }
        if (data?.user) {
          setProfile(data.user);
          await storage.setJson(STORAGE_KEYS.profile, data.user);
          onSaved?.(data.user);
        }
        setStatus('\u4fdd\u5b58\u6210\u529f\u3002');
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError('\u7f51\u7edc\u9519\u8bef\uff1a' + message);
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [onSaved, profile, saving]
  );

  const saveProfile = useCallback(async () => {
    if (!canSave) return;
    await persistProfile();
  }, [canSave, persistProfile]);

  const closeAvatarCrop = useCallback((base64: string | null) => {
    setAvatarCrop(null);
    cropResolveRef.current?.(base64);
    cropResolveRef.current = null;
  }, []);

  const resetAvatarCrop = useCallback(() => {
    setAvatarCrop((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        zoom: AVATAR_MIN_ZOOM,
        displayWidth: prev.baseDisplayWidth,
        displayHeight: prev.baseDisplayHeight,
        offsetX: 0,
        offsetY: 0,
      };
    });
  }, []);

  const zoomAvatarCrop = useCallback((delta: number) => {
    setAvatarCrop((prev) => {
      if (!prev) return prev;
      return applyAvatarCropZoom(prev, prev.zoom + delta);
    });
  }, []);

  const handleCropWheel = useCallback((event: any) => {
    if (Platform.OS !== 'web') return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const deltaY = Number(event?.nativeEvent?.deltaY ?? event?.deltaY ?? 0);
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    zoomAvatarCrop(deltaY < 0 ? AVATAR_ZOOM_STEP : -AVATAR_ZOOM_STEP);
  }, [zoomAvatarCrop]);

  const openAvatarCropOnWeb = useCallback(
    (picked: PickedImage) =>
      new Promise<string | null>((resolve) => {
        const width = Math.max(1, picked.width || 0);
        const height = Math.max(1, picked.height || 0);
        const frameSize = Math.max(
          220,
          Math.min(Math.floor(Dimensions.get('window').width - 48), 340)
        );
        const coverScale = Math.max(frameSize / width, frameSize / height);
        const baseDisplayWidth = width * coverScale;
        const baseDisplayHeight = height * coverScale;
        cropResolveRef.current?.(null);
        cropResolveRef.current = resolve;
        setAvatarCrop({
          mime: picked.mime || 'image/jpeg',
          data: picked.data || '',
          width,
          height,
          frameSize,
          baseDisplayWidth,
          baseDisplayHeight,
          displayWidth: baseDisplayWidth,
          displayHeight: baseDisplayHeight,
          zoom: AVATAR_MIN_ZOOM,
          offsetX: 0,
          offsetY: 0,
        });
      }),
    []
  );

  const exportAvatarCropOnWeb = useCallback(async () => {
    if (Platform.OS !== 'web' || !avatarCrop) return null;
    const doc = (globalThis as any).document as Document | undefined;
    const ImageCtor = (globalThis as any).Image;
    if (!doc || !ImageCtor) return null;

    const dataUrl = `data:${avatarCrop.mime || 'image/jpeg'};base64,${avatarCrop.data || ''}`;
    const image = await new Promise<any>((resolve, reject) => {
      const img = new ImageCtor();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Load crop source failed'));
      img.src = dataUrl;
    });

    const canvas = doc.createElement('canvas');
    canvas.width = AVATAR_OUTPUT_SIZE;
    canvas.height = AVATAR_OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const left = (avatarCrop.displayWidth - avatarCrop.frameSize) / 2 - avatarCrop.offsetX;
    const top = (avatarCrop.displayHeight - avatarCrop.frameSize) / 2 - avatarCrop.offsetY;
    const scaleX = avatarCrop.width / avatarCrop.displayWidth;
    const scaleY = avatarCrop.height / avatarCrop.displayHeight;

    const sw = Math.max(1, Math.min(avatarCrop.width, avatarCrop.frameSize * scaleX));
    const sh = Math.max(1, Math.min(avatarCrop.height, avatarCrop.frameSize * scaleY));
    const sx = Math.max(0, Math.min(avatarCrop.width - sw, left * scaleX));
    const sy = Math.max(0, Math.min(avatarCrop.height - sh, top * scaleY));

    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
    const out = canvas.toDataURL(avatarCrop.mime || 'image/jpeg', 0.92);
    const commaIndex = out.indexOf(',');
    if (commaIndex < 0) return null;
    return out.slice(commaIndex + 1);
  }, [avatarCrop]);

  const uploadAvatarPayload = useCallback(async (mime: string, base64: string) => {
    const ext = (mime || '').split('/')[1] || 'jpg';
      const token = await storage.getString(STORAGE_KEYS.token);
    const response = await fetch(`${API_BASE}/api/chat/upload/image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-file-encoding': 'base64',
        'x-file-ext': ext,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: `data:${mime || 'image/jpeg'};base64,${base64}`,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.data?.url) {
      setError(data?.message || '\u5934\u50cf\u4e0a\u4f20\u5931\u8d25');
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      return null;
    }
    return data.data.url as string;
  }, []);

  const uploadAvatar = useCallback(async () => {
    if (avatarUploading) return;
    setError('');
    setStatus('');
    setPickerActive(true);
    try {
      const picked = await pickImageForPlatform();
      if (!picked?.path) return;
      setAvatarUploading(true);
      let finalMime = picked.mime || 'image/jpeg';
      let finalBase64 = picked.data || '';

      if (!finalBase64) {
        setError('\u5934\u50cf\u6570\u636e\u8bfb\u53d6\u5931\u8d25');
        return;
      }

      if (!isSquareImage(picked.width, picked.height)) {
        if (Platform.OS === 'web') {
          const croppedBase64 = await openAvatarCropOnWeb(picked);
          if (!croppedBase64) return;
          finalBase64 = croppedBase64;
        } else {
          const cropped = await cropImageForPlatform(picked.path);
          if (!cropped?.data) {
            setError('\u5934\u50cf\u88c1\u526a\u5931\u8d25');
            return;
          }
          finalMime = cropped.mime || finalMime;
          finalBase64 = cropped.data;
        }
      }

      const uploadedAvatar = await uploadAvatarPayload(finalMime, finalBase64);
      if (!uploadedAvatar) return;
      updateField('avatar', uploadedAvatar);
      await persistProfile({ avatar: uploadedAvatar });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(message)) {
        setError('\u5934\u50cf\u4e0a\u4f20\u5931\u8d25\uff1a' + message);
        scrollRef.current?.scrollTo({ y: 0, animated: true });
      }
    } finally {
      setPickerActive(false);
      setAvatarUploading(false);
    }
  }, [
    avatarUploading,
    openAvatarCropOnWeb,
    persistProfile,
    updateField,
    uploadAvatarPayload,
  ]);

  return (
    <Animated.View
      style={[
        styles.page,
        {
          paddingTop: insets.top,
          opacity: appear,
          transform: [
            {
              translateX: appear.interpolate({
                inputRange: [0, 1],
                outputRange: [-18, 0],
              }),
            },
          ],
        },
      ]}
      {...(allowGestures ? panResponder.panHandlers : {})}
    >
      {allowGestures ? (
        <>
          <Pressable style={styles.edgeLeft} onPress={runExit} />
          <Pressable style={styles.edgeRight} onPress={runExit} />
        </>
      ) : null}

      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={runExit} hitSlop={10}>
          <BackIcon />
        </Pressable>
        <Text style={styles.title}>{'\u7f16\u8f91\u8d44\u6599'}</Text>
        <Pressable
          style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
          onPress={saveProfile}
          disabled={!canSave}
        >
          <Text style={styles.saveText}>
            {saving ? '\u4fdd\u5b58\u4e2d...' : '\u4fdd\u5b58'}
          </Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          scrollEnabled={!avatarCrop}
        >
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {status ? <Text style={styles.status}>{status}</Text> : null}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{'\u8d26\u53f7\u4fe1\u606f'}</Text>
            <View style={styles.readRow}>
              <Text style={styles.readLabel}>{'\u8d26\u53f7'}</Text>
              <Text style={styles.readValue}>{profile.username || '--'}</Text>
            </View>
            <View style={styles.readRow}>
              <Text style={styles.readLabel}>UID</Text>
              <Text style={styles.readValue}>
                {profile.uid ? String(profile.uid) : '--'}
              </Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{'\u57fa\u7840\u8d44\u6599'}</Text>
            <FormField
              label={'\u6635\u79f0'}
              value={profile.nickname || ''}
              onChange={(value) => updateField('nickname', value)}
              placeholder={'\u8bf7\u8f93\u5165\u6635\u79f0'}
            />
            <FormField
              label={'\u7b7e\u540d'}
              value={profile.signature || ''}
              onChange={(value) => updateField('signature', value)}
              placeholder={'\u586b\u5199\u4e2a\u6027\u7b7e\u540d'}
              multiline
            />
            <SelectField
              label={'\u6027\u522b'}
              value={profile.gender || ''}
              placeholder={'\u8bf7\u9009\u62e9'}
              onPress={() => {
                setSearchQuery('');
                setGenderOpen(true);
              }}
            />
            <SelectField
              label={'\u751f\u65e5'}
              value={profile.birthday || ''}
              placeholder={'\u8bf7\u9009\u62e9'}
              onPress={() => setBirthdayOpen(true)}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{'\u5730\u533a\u4fe1\u606f'}</Text>
            <SelectField
              label={'\u56fd\u5bb6'}
              value={profile.country || ''}
              placeholder={'\u8bf7\u9009\u62e9\u56fd\u5bb6'}
              onPress={() => {
                setSearchQuery('');
                setCountryOpen(true);
              }}
            />
            {isChina ? (
              <>
                <SelectField
                  label={'\u7701\u4efd'}
                  value={profile.province || ''}
                  placeholder={'\u8bf7\u9009\u62e9\u7701\u4efd'}
                  onPress={() => setProvinceOpen(true)}
                />
                {profile.province ? (
                  <SelectField
                    label={'\u57ce\u5e02'}
                    value={profile.region || ''}
                    placeholder={'\u8bf7\u9009\u62e9\u57ce\u5e02'}
                    onPress={() => setCityOpen(true)}
                  />
                ) : null}
              </>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{'\u5934\u50cf'}</Text>
            <View style={styles.avatarRow}>
              <View style={styles.avatarPreview}>
                {avatarSrc && !avatarFailed ? (
                  <Image
                    key={avatarSrc}
                    source={{
                      uri: avatarSrc,
                      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
                    }}
                    style={styles.avatarImg}
                    onError={() => setAvatarFailed(true)}
                  />
                ) : (
                  <View style={styles.avatarFallbackWrap}>
                    <Text style={styles.avatarFallback}>{'\u65e0'}</Text>
                  </View>
                )}
              </View>
              <View style={styles.avatarActions}>
                <Pressable
                  style={[styles.avatarBtn, avatarUploading && styles.avatarBtnDisabled]}
                  onPress={uploadAvatar}
                  disabled={avatarUploading}
                >
                  <Text style={styles.avatarBtnText}>
                    {avatarUploading ? '\u4e0a\u4f20\u4e2d...' : '\u9009\u62e9\u56fe\u7247'}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.avatarGhost}
                  onPress={() => updateField('avatar', '')}
                >
                  <Text style={styles.avatarGhostText}>{'\u6e05\u9664'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {avatarCrop ? (
        <View style={styles.cropMask}>
          <Pressable
            style={styles.cropMaskBackdrop}
            onPress={() => closeAvatarCrop(null)}
          />
          <View style={styles.cropPanel}>
            <Text style={styles.cropTitle}>{'\u8c03\u6574\u5934\u50cf\u88c1\u526a'}</Text>
            <Text style={styles.cropHint}>
              {'\u62d6\u52a8\u56fe\u7247\uff0cWeb \u53ef\u7528\u6eda\u8f6e/\u53cc\u6307\u7f29\u653e\uff0c\u4f7f\u4eba\u50cf\u4f4d\u4e8e\u6846\u5185'}
            </Text>
            <View style={styles.cropFrameWrap}>
              <View
                style={[styles.cropFrame, { width: avatarCrop.frameSize, height: avatarCrop.frameSize }]}
                {...(Platform.OS === 'web' ? ({ onWheel: handleCropWheel } as any) : {})}
                {...cropPanResponder.panHandlers}
              >
                <Image
                  source={{ uri: `data:${avatarCrop.mime || 'image/jpeg'};base64,${avatarCrop.data}` }}
                  style={[
                    styles.cropImage,
                    {
                      width: avatarCrop.displayWidth,
                      height: avatarCrop.displayHeight,
                      transform: [
                        { translateX: avatarCrop.offsetX },
                        { translateY: avatarCrop.offsetY },
                      ],
                    },
                  ]}
                />
              </View>
            </View>
            <View style={styles.cropZoomRow}>
              <Pressable
                style={[styles.cropMiniBtn, avatarCrop.zoom <= AVATAR_MIN_ZOOM && styles.cropMiniBtnDisabled]}
                onPress={() => zoomAvatarCrop(-AVATAR_ZOOM_STEP)}
                disabled={avatarCrop.zoom <= AVATAR_MIN_ZOOM}
              >
                <Text style={styles.cropMiniBtnText}>-</Text>
              </Pressable>
              <Text style={styles.cropZoomText}>{`x${avatarCrop.zoom.toFixed(2)}`}</Text>
              <Pressable
                style={[styles.cropMiniBtn, avatarCrop.zoom >= AVATAR_MAX_ZOOM && styles.cropMiniBtnDisabled]}
                onPress={() => zoomAvatarCrop(AVATAR_ZOOM_STEP)}
                disabled={avatarCrop.zoom >= AVATAR_MAX_ZOOM}
              >
                <Text style={styles.cropMiniBtnText}>+</Text>
              </Pressable>
            </View>
            <View style={styles.cropActions}>
              <Pressable
                style={[styles.cropBtn, styles.cropBtnGhost]}
                onPress={() => closeAvatarCrop(null)}
              >
                <Text style={styles.cropBtnGhostText}>{'\u53d6\u6d88'}</Text>
              </Pressable>
              <Pressable
                style={[styles.cropBtn, styles.cropBtnGhost]}
                onPress={resetAvatarCrop}
              >
                <Text style={styles.cropBtnGhostText}>{'\u91cd\u7f6e'}</Text>
              </Pressable>
              <Pressable
                style={[styles.cropBtn, styles.cropBtnPrimary]}
                onPress={async () => {
                  const croppedBase64 = await exportAvatarCropOnWeb();
                  if (!croppedBase64) {
                    setError('\u5934\u50cf\u88c1\u526a\u5931\u8d25');
                    closeAvatarCrop(null);
                    return;
                  }
                  closeAvatarCrop(croppedBase64);
                }}
              >
                <Text style={styles.cropBtnPrimaryText}>{'\u786e\u8ba4'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      <SelectModal
        visible={countryOpen}
        title={"\u9009\u62e9\u56fd\u5bb6"}
        value={profile.country || ''}
        searchQuery={searchQuery}
        onSearch={setSearchQuery}
        onClose={() => setCountryOpen(false)}
        onSelect={(value) => {
          updateField('country', value);
          setCountryOpen(false);
        }}
        options={COUNTRIES}
      />

      <SelectModal
        visible={provinceOpen}
        title={"\u9009\u62e9\u7701\u4efd"}
        value={profile.province || ''}
        onClose={() => setProvinceOpen(false)}
        onSelect={(value) => {
          updateField('province', value);
          updateField('region', '');
          setProvinceOpen(false);
        }}
        options={provinceOptions}
      />

      <SelectModal
        visible={cityOpen}
        title={"\u9009\u62e9\u57ce\u5e02"}
        value={profile.region || ''}
        onClose={() => setCityOpen(false)}
        onSelect={(value) => {
          updateField('region', value);
          setCityOpen(false);
        }}
        options={cityOptions}
      />

      <SelectModal
        visible={genderOpen}
        title={"\u9009\u62e9\u6027\u522b"}
        value={profile.gender || ''}
        onClose={() => setGenderOpen(false)}
        onSelect={(value) => {
          updateField('gender', value);
          setGenderOpen(false);
        }}
        options={GENDER_OPTIONS}
      />

      <BirthdayModal
        visible={birthdayOpen}
        onClose={() => setBirthdayOpen(false)}
        onConfirm={(value) => {
          updateField('birthday', value);
          setBirthdayOpen(false);
        }}
        year={birthdayYear || profile.birthday?.slice(0, 4) || ''}
        month={birthdayMonth || profile.birthday?.slice(5, 7) || ''}
        day={birthdayDay || profile.birthday?.slice(8, 10) || ''}
        onYearChange={setBirthdayYear}
        onMonthChange={setBirthdayMonth}
        onDayChange={setBirthdayDay}
      />
    </Animated.View>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#b0b0b0"
        style={[styles.input, multiline && styles.inputMultiline]}
        multiline={multiline}
      />
    </View>
  );
}

function SelectField({
  label,
  value,
  placeholder,
  onPress,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.field} onPress={onPress}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.selectBox}>
        <Text style={[styles.selectValue, !value && styles.selectPlaceholder]}>
          {value || placeholder || '\u8bf7\u9009\u62e9'}
        </Text>
        <Text style={styles.selectArrow}>{'\u203a'}</Text>
      </View>
    </Pressable>
  );
}

function SelectModal({
  visible,
  title,
  options,
  onSelect,
  onClose,
  value,
  searchQuery,
  onSearch,
}: {
  visible: boolean;
  title: string;
  options: string[];
  onSelect: (value: string) => void;
  onClose: () => void;
  value: string;
  searchQuery?: string;
  onSearch?: (value: string) => void;
}) {
  const [tempValue, setTempValue] = useState(value);
  const filtered = useMemo(() => {
    if (!searchQuery) return options;
    const lower = searchQuery.toLowerCase();
    return options.filter((item) => item.toLowerCase().includes(lower));
  }, [options, searchQuery]);

  useEffect(() => {
    if (!visible) return;
    if (filtered.length === 0) {
      setTempValue('');
      return;
    }
    if (!filtered.includes(value)) {
      setTempValue(filtered[0]);
    } else {
      setTempValue(value);
    }
  }, [filtered, value, visible]);

  if (!visible) return null;
  return (
    <View style={styles.modalMask}>
      <Pressable style={styles.modalMask} onPress={onClose} />
      <View style={styles.modalSheet}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Pressable onPress={onClose}>
          <Text style={styles.modalClose}>{'\u5173\u95ed'}</Text>
          </Pressable>
        </View>
        {onSearch ? (
          <TextInput
            value={searchQuery}
            onChangeText={onSearch}
            placeholder={'\u641c\u7d22'}
            placeholderTextColor="#999"
            style={styles.modalSearch}
          />
        ) : null}
        <View style={styles.modalBody}>
          {filtered.length === 0 ? (
          <Text style={styles.modalEmpty}>{'\u6ca1\u6709\u5339\u914d\u7ed3\u679c'}</Text>
          ) : (
            <ListPicker options={filtered} value={tempValue} onChange={setTempValue} />
          )}
        </View>
        <Pressable
          style={styles.modalConfirm}
          onPress={() => {
            if (!tempValue) return;
            onSelect(tempValue);
          }}
        >
          <Text style={styles.modalConfirmText}>{'\u786e\u5b9a'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function BirthdayModal({
  visible,
  onClose,
  onConfirm,
  year,
  month,
  day,
  onYearChange,
  onMonthChange,
  onDayChange,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  year: string;
  month: string;
  day: string;
  onYearChange: (value: string) => void;
  onMonthChange: (value: string) => void;
  onDayChange: (value: string) => void;
}) {
  const [tempYear, setTempYear] = useState(year);
  const [tempMonth, setTempMonth] = useState(month);
  const [tempDay, setTempDay] = useState(day);
  const yearNum = Number(tempYear) || new Date().getFullYear();
  const monthNum = Number(tempMonth) || 1;
  const days = useMemo(() => DAY_OPTIONS(yearNum, monthNum), [monthNum, yearNum]);

  useEffect(() => {
    if (!visible) return;
    const now = new Date();
    const nextYear = year || String(now.getFullYear());
    const nextMonth = month || String(now.getMonth() + 1).padStart(2, '0');
    const nextDay = day || String(now.getDate()).padStart(2, '0');
    setTempYear(nextYear);
    setTempMonth(nextMonth);
    setTempDay(nextDay);
  }, [day, month, year, visible]);

  useEffect(() => {
    if (!days.includes(tempDay)) {
      setTempDay(days[0] || '');
    }
  }, [days, tempDay]);

  if (!visible) return null;
  return (
    <View style={styles.modalMask}>
      <Pressable style={styles.modalMask} onPress={onClose} />
      <View style={styles.modalSheet}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{'\u9009\u62e9\u751f\u65e5'}</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>{'\u5173\u95ed'}</Text>
          </Pressable>
        </View>
        <View style={[styles.modalBody, styles.birthdayGroup]}>
          <View style={styles.birthdayColumn}>
            <Text style={styles.birthdayLabel}>{'\u5e74'}</Text>
            <ListPicker
              options={YEAR_OPTIONS}
              value={tempYear}
              onChange={(value) => {
                setTempYear(value);
                onYearChange(value);
              }}
            />
          </View>
          <View style={styles.birthdayColumn}>
            <Text style={styles.birthdayLabel}>{'\u6708'}</Text>
            <ListPicker
              options={MONTH_OPTIONS}
              value={tempMonth}
              onChange={(value) => {
                setTempMonth(value);
                onMonthChange(value);
              }}
            />
          </View>
          <View style={styles.birthdayColumn}>
            <Text style={styles.birthdayLabel}>{'\u65e5'}</Text>
            <ListPicker
              options={days}
              value={tempDay}
              onChange={(value) => {
                setTempDay(value);
                onDayChange(value);
              }}
            />
          </View>
        </View>
        <Pressable
          style={styles.modalConfirm}
          onPress={() => {
            if (!tempYear || !tempMonth || !tempDay) return;
            onConfirm(`${tempYear}-${tempMonth}-${tempDay}`);
          }}
        >
          <Text style={styles.modalConfirmText}>{'\u786e\u5b9a'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ListPicker({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <FlatList
      data={options}
      keyExtractor={(item) => item}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews
      initialNumToRender={24}
      maxToRenderPerBatch={24}
      windowSize={7}
      style={styles.listPicker}
      renderItem={({ item }) => (
        <Pressable
          style={[styles.listItem, item === value && styles.listItemActive]}
          onPress={() => onChange(item)}
        >
          <Text style={[styles.listText, item === value && styles.listTextActive]}>
            {item}
          </Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f2f2f7',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  saveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: '#4a9df8',
  },
  saveBtnDisabled: {
    backgroundColor: '#9ec5fb',
  },
  saveText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },
  body: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 16,
  },
  error: {
    color: '#d93026',
    fontSize: 13,
    marginBottom: 8,
  },
  status: {
    color: '#1a8f3e',
    fontSize: 13,
    marginBottom: 8,
  },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginBottom: 10,
  },
  readRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  readLabel: {
    fontSize: 14,
    color: '#666',
  },
  readValue: {
    fontSize: 14,
    color: '#333',
  },
  field: {
    marginBottom: 12,
  },
  label: {
    fontSize: 14,
    color: '#333',
    marginBottom: 6,
  },
  selectBox: {
    borderWidth: 1,
    borderColor: '#e3e3e3',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fafafa',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectValue: {
    fontSize: 14,
    color: '#1a1a1a',
  },
  selectPlaceholder: {
    color: '#999',
  },
  selectArrow: {
    fontSize: 18,
    color: '#999',
  },
  input: {
    borderWidth: 1,
    borderColor: '#e3e3e3',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#1a1a1a',
    backgroundColor: '#fafafa',
  },
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  avatarPreview: {
    width: 64,
    height: 64,
    borderRadius: 32,
    overflow: 'hidden',
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  avatarFallbackWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  avatarFallback: {
    fontSize: 12,
    color: '#999',
  },
  avatarActions: {
    flex: 1,
    justifyContent: 'center',
    gap: 10,
  },
  avatarBtn: {
    backgroundColor: '#4a9df8',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  avatarBtnDisabled: {
    opacity: 0.6,
  },
  avatarBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  avatarGhost: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  avatarGhostText: {
    color: '#666',
    fontSize: 12,
  },
  cropMask: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 20,
    justifyContent: 'flex-end',
  },
  cropMaskBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  cropPanel: {
    backgroundColor: '#17191f',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
  },
  cropTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  cropHint: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 6,
  },
  cropFrameWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    marginBottom: 12,
  },
  cropFrame: {
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? ({ touchAction: 'none', userSelect: 'none' } as any) : null),
  },
  cropImage: {
    resizeMode: 'cover',
  },
  cropZoomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 10,
  },
  cropMiniBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  cropMiniBtnDisabled: {
    opacity: 0.45,
  },
  cropMiniBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  cropZoomText: {
    color: '#d2e6ff',
    fontSize: 12,
    fontWeight: '600',
    minWidth: 46,
    textAlign: 'center',
  },
  cropActions: {
    flexDirection: 'row',
    gap: 10,
  },
  cropBtn: {
    flex: 1,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  cropBtnGhost: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  cropBtnGhostText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  cropBtnPrimary: {
    backgroundColor: '#4a9df8',
  },
  cropBtnPrimaryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  modalMask: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '50%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  modalClose: {
    fontSize: 13,
    color: '#4a9df8',
  },
  modalSearch: {
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
    fontSize: 14,
  },
  modalBody: {
    flex: 1,
    minHeight: 0,
    marginBottom: 10,
  },
  listPicker: {
    flex: 1,
    minHeight: 0,
  },
  listItem: {
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  listItemActive: {
    backgroundColor: 'rgba(74,157,248,0.12)',
  },
  listText: {
    fontSize: 14,
    color: '#333',
  },
  listTextActive: {
    color: '#1a1a1a',
    fontWeight: '600',
  },
  modalEmpty: {
    textAlign: 'center',
    paddingVertical: 16,
    color: '#999',
  },
  birthdayGroup: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
    flex: 1,
  },
  birthdayColumn: {
    flex: 1,
    minHeight: 0,
  },
  birthdayLabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 6,
  },
  modalConfirm: {
    marginTop: 12,
    backgroundColor: '#4a9df8',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modalConfirmText: {
    color: '#fff',
    fontWeight: '600',
  },
  edgeLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 20,
    zIndex: 5,
  },
  edgeRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 20,
    zIndex: 5,
  },
});

function BackIcon() {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}



