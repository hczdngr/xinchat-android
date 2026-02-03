import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const insets = useSafeAreaInsets();
  const displayName = profile.nickname || profile.username || "加载中...";
  const uidText = profile.uid ? String(profile.uid) : "...";

  return (
    <View style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top, height: 44 + insets.top }]}>
        <Pressable style={styles.back} onPress={onBack}>
          <BackIcon />
        </Pressable>
        <Text style={styles.title}>我的资料</Text>
        <View style={styles.headerRight} />
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

      <View style={[styles.bottomBar, { paddingBottom: 16 + insets.bottom }]}>
        <Pressable style={styles.editBtn} onPress={onEdit}>
          <Text style={styles.editText}>编辑资料</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 15,
    backgroundColor: "#fff",
  },
  back: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -5,
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  headerRight: {
    width: 30,
  },
  profileContainer: {
    paddingHorizontal: 20,
    paddingVertical: 24,
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
