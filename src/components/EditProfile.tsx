import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Dimensions,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Path, Polyline } from "react-native-svg";
import { API_BASE } from "../config";
import { storage } from "../storage";

type ProfileData = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  gender?: string;
  birthday?: string;
};

type Props = {
  onBack: () => void;
};

export default function EditProfile({ onBack }: Props) {
  const appear = useRef(new Animated.Value(0)).current;
  const isLeaving = useRef(false);
  const [profile, setProfile] = useState<ProfileData>({});

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
    Animated.timing(appear, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [appear]);

  useEffect(() => {
    const handler = () => {
      runExit();
      return true;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => sub.remove();
  }, [runExit]);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const token = await storage.getString("xinchat.token");
        const response = await fetch(`${API_BASE}/api/profile`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && data?.user) {
          setProfile(data.user);
        }
      } catch {}
    };
    void loadProfile();
  }, []);

  const editField = (field: string) => {
    console.log("edit field:", field);
  };

  return (
    <Animated.View
      style={[
        styles.page,
        {
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
        <Text style={styles.title}>编辑资料</Text>
      </View>

      <View style={styles.content}>
        <View style={styles.infoGroup}>
          <Pressable style={styles.infoItem} onPress={() => editField("avatar")}>
            <Text style={styles.label}>头像</Text>
            <View style={styles.valueBox}>
              <Image source={{ uri: profile.avatar || "" }} style={styles.avatarImg} />
              <ArrowIcon />
            </View>
          </Pressable>

          <Pressable style={styles.infoItem} onPress={() => editField("signature")}>
            <Text style={styles.label}>签名</Text>
            <View style={styles.valueBox}>
              <Text style={styles.valueText} numberOfLines={1}>
                {profile.signature || "加载中..."}
              </Text>
              <ArrowIcon />
            </View>
          </Pressable>
        </View>

        <View style={styles.infoGroup}>
          <Pressable style={styles.infoItem} onPress={() => editField("nickname")}>
            <Text style={styles.label}>昵称</Text>
            <View style={styles.valueBox}>
              <Text style={styles.valueText} numberOfLines={1}>
                {profile.nickname || "加载中..."}
              </Text>
              <ArrowIcon />
            </View>
          </Pressable>

          <Pressable style={styles.infoItem} onPress={() => editField("gender")}>
            <Text style={styles.label}>性别</Text>
            <View style={styles.valueBox}>
              <Text style={styles.valueText} numberOfLines={1}>
                {profile.gender || "..."}
              </Text>
              <ArrowIcon />
            </View>
          </Pressable>

          <Pressable style={styles.infoItem} onPress={() => editField("birthday")}>
            <Text style={styles.label}>生日</Text>
            <View style={styles.valueBox}>
              <Text style={styles.valueText} numberOfLines={1}>
                {profile.birthday || "..."}
              </Text>
              <ArrowIcon />
            </View>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#f2f2f7",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.1)",
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
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  infoGroup: {
    backgroundColor: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 20,
  },
  infoItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    position: "relative",
  },
  label: {
    fontSize: 16,
    color: "#000",
    flexShrink: 0,
  },
  valueBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  valueText: {
    fontSize: 16,
    color: "#8a8a8e",
    textAlign: "right",
    maxWidth: 200,
  },
  avatarImg: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#f0f0f0",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
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

function ArrowIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Polyline
        points="9 18 15 12 9 6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
