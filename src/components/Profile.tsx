import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Dimensions,
  Image,
  Platform,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { normalizeImageUrl } from "../config";

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
  profile: ProfileData;
  onBack: () => void;
  onEdit?: () => void;
  onRefresh?: () => void;
  title?: string;
  onAction?: () => void;
  actionLabel?: string;
};

const buttonShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.08)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.03,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 8,
        elevation: 1,
      };

export default function Profile({
  profile,
  onBack,
  onEdit,
  onRefresh,
  title,
  onAction,
  actionLabel,
}: Props) {
  const insets = useSafeAreaInsets();
  const headerTitle = title || '我的资料';
  const displayValue = useCallback((value?: string | number) => {
    if (value === undefined || value === null) return "--";
    const text = String(value).trim();
    return text ? text : "--";
  }, []);
  const regionText =
    profile.country || profile.province || profile.region
      ? [profile.country, profile.province, profile.region]
          .filter((item) => item && String(item).trim())
          .join(" / ")
      : "--";
  const displayName = profile.nickname || profile.username || '\u52a0\u8f7d\u4e2d...';
  const uidText = profile.uid ? String(profile.uid) : "...";
  const avatarUrl = useMemo(() => normalizeImageUrl(profile.avatar), [profile.avatar]);
  const avatarVersion = useMemo(() => {
    const clean = avatarUrl.split("?")[0].replace(/\/+$/, "");
    const name = clean.split("/").pop();
    return name || String(profile.avatar || "1");
  }, [avatarUrl, profile.avatar]);
  const avatarSrc = useMemo(() => {
    if (!avatarUrl) return "";
    if (avatarUrl.startsWith("data:")) return avatarUrl;
    const joiner = avatarUrl.includes("?") ? "&" : "?";
    return encodeURI(`${avatarUrl}${joiner}v=${encodeURIComponent(avatarVersion)}`);
  }, [avatarUrl, avatarVersion]);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const appear = useRef(new Animated.Value(0)).current;
  const isLeaving = useRef(false);

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
        const { width } = Dimensions.get("window");
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

  useEffect(() => {
    const handler = () => {
      runExit();
      return true;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => sub.remove();
  }, [runExit]);

  useEffect(() => {
    Animated.timing(appear, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [appear]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  useEffect(() => {
    if (!avatarSrc || avatarSrc.startsWith("data:")) return;
    Image.getSize(
      avatarSrc,
      () => setAvatarFailed(false),
      () => setAvatarFailed(true)
    );
  }, [avatarSrc]);

  useEffect(() => {
    onRefresh?.();
  }, [onRefresh]);

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
      {...panResponder.panHandlers}
    >
      <Pressable style={styles.edgeLeft} onPress={runExit} />
      <Pressable style={styles.edgeRight} onPress={runExit} />

      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={runExit} hitSlop={10}>
          <BackIcon />
        </Pressable>
        <Text style={styles.title}>{headerTitle}</Text>
      </View>

      <View style={styles.profileContainer}>
        <View style={styles.avatarBox}>
          {avatarSrc && !avatarFailed ? (
            <Image
              key={avatarSrc}
              source={{
                uri: avatarSrc,
                headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
              }}
              style={styles.avatarImg}
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <View style={styles.avatarFallbackWrap}>
              <Text style={styles.avatarFallback}>U</Text>
            </View>
          )}
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.nickname}>{displayName}</Text>
          <View style={styles.userIdRow}>
            <Text style={styles.userIdLabel}>{'\u8d26\u53f7\uff1a'}</Text>
            <Text style={styles.userIdValue}>{uidText}</Text>
          </View>
        </View>
      </View>


      <View style={styles.detailSection}>
        <Text style={styles.sectionTitle}>{'\u8d44\u6599'}</Text>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{'\u7528\u6237\u540d'}</Text>
          <Text style={styles.detailValue}>{displayValue(profile.username)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{'\u6635\u79f0'}</Text>
          <Text style={styles.detailValue}>{displayValue(profile.nickname)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>UID</Text>
          <Text style={styles.detailValue}>{displayValue(profile.uid)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{'\u7b7e\u540d'}</Text>
          <Text style={styles.detailValue}>{displayValue(profile.signature)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{'\u6027\u522b'}</Text>
          <Text style={styles.detailValue}>{displayValue(profile.gender)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{'\u751f\u65e5'}</Text>
          <Text style={styles.detailValue}>{displayValue(profile.birthday)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{'\u5730\u533a'}</Text>
          <Text style={styles.detailValue}>{regionText}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{'\u5934\u50cf'}</Text>
          <Text style={styles.detailValue}>{profile.avatar ? '\u5df2\u8bbe\u7f6e' : '--'}</Text>
        </View>
      </View>

      {onEdit || onAction ? (
        <View style={styles.bottomBar}>
          {onAction ? (
            <Pressable
              style={[styles.actionBtn, onEdit ? styles.actionBtnSpacing : null]}
              onPress={onAction}
            >
              <Text style={styles.actionText}>{actionLabel || '发消息'}</Text>
            </Pressable>
          ) : null}
          {onEdit ? (
            <Pressable style={styles.editBtn} onPress={onEdit}>
              <Text style={styles.editText}>{'\u7f16\u8f91\u8d44\u6599'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#f5f6fa",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#f5f6fa",
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  profileContainer: {
    paddingHorizontal: 20,
    paddingVertical: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
  },
  avatarBox: {
    width: 80,
    height: 80,
    borderRadius: 40,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  avatarFallbackWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  avatarImg: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  avatarFallback: {
    fontSize: 20,
    fontWeight: "600",
    color: "#999",
  },
  infoBox: {
    flex: 1,
    gap: 8,
  },
  nickname: {
    fontSize: 24,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  userIdRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  userIdLabel: {
    fontSize: 14,
    color: "#999",
  },
  userIdValue: {
    fontSize: 14,
    color: "#999",
  },
  detailSection: {
    marginHorizontal: 20,
    padding: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  detailLabel: {
    fontSize: 13,
    color: "#666",
  },
  detailValue: {
    flex: 1,
    textAlign: "right",
    fontSize: 13,
    color: "#222",
  },
  bottomBar: {
    marginTop: "auto",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  actionBtn: {
    height: 44,
    borderRadius: 22,
    backgroundColor: "#4a9df8",
    alignItems: "center",
    justifyContent: "center",
    ...buttonShadowStyle,
  },
  actionBtnSpacing: {
    marginBottom: 12,
  },
  actionText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#fff",
  },
  editBtn: {
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    alignItems: "center",
    justifyContent: "center",
    ...buttonShadowStyle,
  },
  editText: {
    fontSize: 16,
    fontWeight: "500",
    color: "#333",
  },
  edgeLeft: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 20,
    zIndex: 5,
  },
  edgeRight: {
    position: "absolute",
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


