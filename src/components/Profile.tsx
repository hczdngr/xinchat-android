import React, { useCallback, useEffect, useRef } from "react";
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
import Svg, { Path } from "react-native-svg";

type ProfileData = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
};

type Props = {
  profile: ProfileData;
  onBack: () => void;
  onEdit: () => void;
};

export default function Profile({ profile, onBack, onEdit }: Props) {
  const displayName = profile.nickname || profile.username || "加载中...";
  const uidText = profile.uid ? String(profile.uid) : "...";
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
        <Text style={styles.title}>我的资料</Text>
      </View>

      <View style={styles.profileContainer}>
        <View style={styles.avatarBox}>
          {profile.avatar ? (
            <Image source={{ uri: profile.avatar }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarFallback}>U</Text>
          )}
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.nickname}>{displayName}</Text>
          <View style={styles.userIdRow}>
            <Text style={styles.userIdLabel}>账号：</Text>
            <Text style={styles.userIdValue}>{uidText}</Text>
          </View>
        </View>
      </View>

      <View style={styles.bottomBar}>
        <Pressable style={styles.editBtn} onPress={onEdit}>
          <Text style={styles.editText}>编辑资料</Text>
        </Pressable>
      </View>
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
  bottomBar: {
    marginTop: "auto",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  editBtn: {
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.03,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 1,
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
