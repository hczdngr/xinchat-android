import React, { useMemo, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { normalizeImageUrl } from '../config';

type ProfileData = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
};

type Props = {
  profile?: ProfileData;
  onBack: () => void;
  onOpenProfile: () => void;
};

type MenuItem = {
  key: 'album' | 'favorite' | 'file' | 'wallet' | 'vip' | 'dress';
  label: string;
  tint: string;
};

const MENU_ITEMS: MenuItem[] = [
  { key: 'album', label: '相册', tint: '#e7bc10' },
  { key: 'favorite', label: '收藏', tint: '#1f9de7' },
  { key: 'file', label: '文件', tint: '#1f9de7' },
  { key: 'wallet', label: '钱包', tint: '#1f9de7' },
  { key: 'vip', label: '会员中心', tint: '#e65378' },
  { key: 'dress', label: '个性装扮', tint: '#e65378' },
];

const surfaceShadowStyle =
  Platform.OS === 'web'
    ? ({ boxShadow: '0px 10px 32px rgba(35, 53, 80, 0.16)' } as any)
    : {
        shadowColor: '#22344f',
        shadowOpacity: 0.12,
        shadowOffset: { width: 0, height: 12 },
        shadowRadius: 22,
        elevation: 7,
      };

export default function UserCenter({ profile, onBack, onOpenProfile }: Props) {
  const insets = useSafeAreaInsets();
  const [avatarFailed, setAvatarFailed] = useState(false);

  const displayName = useMemo(
    () => String(profile?.nickname || profile?.username || 'XinChat 用户'),
    [profile?.nickname, profile?.username]
  );
  const signature = useMemo(
    () => String(profile?.signature || 'undefined.'),
    [profile?.signature]
  );
  const uidTag = useMemo(() => String(profile?.uid || '404'), [profile?.uid]);
  const usernameTag = useMemo(
    () => String(profile?.username || 'NotFound'),
    [profile?.username]
  );
  const avatarUrl = useMemo(() => normalizeImageUrl(profile?.avatar), [profile?.avatar]);
  const avatarText = useMemo(() => displayName.slice(0, 2), [displayName]);

  return (
    <View style={styles.page}>
      <ScrollView
        style={styles.scroll}
        bounces={false}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 10) + 108 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.hero, { paddingTop: insets.top + 10 }]}>
          {avatarUrl && !avatarFailed ? (
            <Image
              source={{ uri: avatarUrl }}
              style={styles.heroImage}
              resizeMode="cover"
              onError={() => setAvatarFailed(true)}
            />
          ) : null}
          <View style={styles.heroMask} />
          <View style={styles.heroGlowA} />
          <View style={styles.heroGlowB} />

          <View style={styles.heroTopRow}>
            <View style={styles.checkinChip}>
              <CheckinIcon />
              <Text style={styles.checkinChipText}>打卡</Text>
            </View>

            <View style={styles.heroActionRow}>
              <View style={styles.musicChip}>
                <Text style={styles.musicChipText}>😊 听歌中</Text>
              </View>
              <View style={styles.heroRoundGhost}>
                <ThemeIcon />
              </View>
              <Pressable style={styles.heroRoundGhost} onPress={onBack} hitSlop={8}>
                <CloseIcon />
              </Pressable>
            </View>
          </View>

          <View style={styles.content}>
            <Pressable style={styles.userCard} onPress={onOpenProfile}>
              <View style={styles.userCardTopRow}>
                <View style={styles.userMainRow}>
                  <View style={styles.userAvatarWrap}>
                    {avatarUrl && !avatarFailed ? (
                      <Image
                        source={{ uri: avatarUrl }}
                        style={styles.userAvatar}
                        resizeMode="cover"
                        onError={() => setAvatarFailed(true)}
                      />
                    ) : (
                      <Text style={styles.userAvatarFallback}>{avatarText}</Text>
                    )}
                  </View>
                  <View style={styles.userInfo}>
                    <View style={styles.userNameRow}>
                      <Text style={styles.userName} numberOfLines={1}>
                        {displayName}
                      </Text>
                      <View style={styles.switchAccountBtn}>
                        <Text style={styles.switchAccountText}>切换账号</Text>
                      </View>
                    </View>
                    <Text style={styles.userSignature} numberOfLines={1}>
                      {signature}
                    </Text>
                    <Text style={styles.userVipLine}>🎗4SVIP8 👑🌙⭐⭐ 💍8</Text>
                    <View style={styles.tagRow}>
                      <View style={styles.tagPill}>
                        <Text style={styles.tagText}>{uidTag}</Text>
                      </View>
                      <View style={styles.tagPill}>
                        <Text style={styles.tagText}>{usernameTag}</Text>
                      </View>
                    </View>
                  </View>
                </View>

                <View style={styles.cardTopAction}>
                  <GridIcon />
                </View>
              </View>

              <View style={styles.userCardDivider} />

              <View style={styles.userCardBottomRow}>
                <Text style={styles.userCardBottomLeft}>+ 创建QQ秀</Text>
                <View style={styles.userCardBottomCenter}>
                  <InteractionIcon />
                  <Text style={styles.userCardBottomCenterText}>52条新互动</Text>
                </View>
                <Text style={styles.userCardBottomRight}>👍9999+</Text>
              </View>
            </Pressable>

            <View style={styles.menuSection}>
              {MENU_ITEMS.map((item) => (
                <View key={item.key} style={styles.menuRow}>
                  <View style={styles.menuLeft}>
                    <View style={styles.menuIconWrap}>
                      <MenuIcon kind={item.key} color={item.tint} />
                    </View>
                    <Text style={styles.menuText}>{item.label}</Text>
                  </View>
                  <ChevronRightIcon />
                </View>
              ))}
            </View>
          </View>
        </View>
      </ScrollView>

      <View style={[styles.bottomTools, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <View style={styles.bottomToolItem}>
          <SettingsIcon />
          <Text style={styles.bottomToolText}>设置</Text>
        </View>
        <View style={styles.bottomToolItem}>
          <MoonIcon />
          <Text style={styles.bottomToolText}>夜间</Text>
        </View>
        <View style={styles.bottomToolItem}>
          <MenuBarsIcon />
          <Text style={styles.bottomToolText}>汉川</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f4f4f6',
  },
  scroll: {
    flex: 1,
  },
  hero: {
    height: 266,
    paddingHorizontal: 14,
    overflow: 'hidden',
    backgroundColor: '#d7d9df',
    position: 'relative',
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.46,
  },
  heroMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(20, 18, 20, 0.18)',
  },
  heroGlowA: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 120,
    top: -90,
    right: -36,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  heroGlowB: {
    position: 'absolute',
    width: 210,
    height: 210,
    borderRadius: 105,
    bottom: -90,
    left: -52,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  heroTopRow: {
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  checkinChip: {
    height: 38,
    borderRadius: 19,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.38)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkinChipText: {
    fontSize: 17,
    color: '#ffffff',
    fontWeight: '500',
  },
  heroActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  musicChip: {
    height: 38,
    borderRadius: 19,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.42)',
    justifyContent: 'center',
  },
  musicChipText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '500',
  },
  heroRoundGhost: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    marginTop: -34,
    paddingHorizontal: 10,
  },
  userCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#e5e5e8',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 12,
    ...surfaceShadowStyle,
  },
  userCardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  userMainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flex: 1,
    minWidth: 0,
    gap: 12,
  },
  userAvatarWrap: {
    width: 78,
    height: 78,
    borderRadius: 16,
    backgroundColor: '#f0f2f6',
    borderWidth: 1,
    borderColor: '#ebedf1',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userAvatar: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  userAvatarFallback: {
    color: '#5a6b7f',
    fontSize: 22,
    fontWeight: '700',
  },
  userInfo: {
    flex: 1,
    minWidth: 0,
    gap: 8,
  },
  userNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  userName: {
    color: '#b08e4d',
    fontSize: 22,
    fontWeight: '500',
    maxWidth: '64%',
  },
  switchAccountBtn: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e4e5e9',
    backgroundColor: '#f8f8fa',
    paddingHorizontal: 10,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchAccountText: {
    color: '#5f5f67',
    fontSize: 14,
  },
  userSignature: {
    color: '#1f1f22',
    fontSize: 14,
  },
  userVipLine: {
    color: '#ac7f2b',
    fontSize: 17,
    lineHeight: 20,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 2,
  },
  tagPill: {
    height: 34,
    borderRadius: 17,
    paddingHorizontal: 15,
    borderWidth: 1,
    borderColor: '#e5e6ea',
    backgroundColor: '#fafafb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagText: {
    color: '#404046',
    fontSize: 14,
    fontWeight: '500',
  },
  cardTopAction: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userCardDivider: {
    marginTop: 12,
    height: 1,
    backgroundColor: '#ececf1',
  },
  userCardBottomRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  userCardBottomLeft: {
    color: '#2b2b2f',
    fontSize: 16,
  },
  userCardBottomCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  userCardBottomCenterText: {
    color: '#2b2b2f',
    fontSize: 16,
  },
  userCardBottomRight: {
    color: '#2b2b2f',
    fontSize: 16,
  },
  menuSection: {
    marginTop: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ececf0',
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  menuRow: {
    height: 74,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f3',
    backgroundColor: '#ffffff',
  },
  menuLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  menuIconWrap: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuText: {
    fontSize: 18,
    color: '#101015',
    fontWeight: '400',
  },
  bottomTools: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 92,
    borderTopWidth: 1,
    borderTopColor: '#e2e3e6',
    backgroundColor: '#f3f4f6',
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-around',
    paddingTop: 10,
  },
  bottomToolItem: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minWidth: 78,
  },
  bottomToolText: {
    fontSize: 14,
    color: '#222328',
  },
});

function MenuIcon({ kind, color }: { kind: MenuItem['key']; color: string }) {
  if (kind === 'album') return <AlbumIcon color={color} />;
  if (kind === 'favorite') return <FavoriteIcon color={color} />;
  if (kind === 'file') return <FileIcon color={color} />;
  if (kind === 'wallet') return <WalletIcon color={color} />;
  if (kind === 'vip') return <VipIcon color={color} />;
  return <DressIcon color={color} />;
}

function CheckinIcon() {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={4} width={18} height={17} rx={4} stroke="#ffffff" strokeWidth={2} />
      <Path d="M8 2V6" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" />
      <Path d="M16 2V6" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" />
      <Path d="M8 12L11 15L16 10" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function ThemeIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M16.6 14.2A6.6 6.6 0 1 1 9.8 7.4C9.8 9.6 11.6 11.4 13.8 11.4C14.8 11.4 15.8 11 16.6 10.4V14.2Z"
        stroke="#ffffff"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Circle cx={18.4} cy={6.4} r={1.4} fill="#ffffff" />
    </Svg>
  );
}

function CloseIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M7 7L17 17" stroke="#ffffff" strokeWidth={2.2} strokeLinecap="round" />
      <Path d="M17 7L7 17" stroke="#ffffff" strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}

function GridIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Rect x={4} y={4} width={6} height={6} rx={1.4} stroke="#6d6e74" strokeWidth={1.8} />
      <Rect x={14} y={4} width={6} height={6} rx={1.4} stroke="#6d6e74" strokeWidth={1.8} />
      <Rect x={4} y={14} width={6} height={6} rx={1.4} stroke="#6d6e74" strokeWidth={1.8} />
      <Rect x={14} y={14} width={6} height={6} rx={1.4} stroke="#6d6e74" strokeWidth={1.8} />
    </Svg>
  );
}

function InteractionIcon() {
  return (
    <Svg width={28} height={16} viewBox="0 0 28 16" fill="none">
      <Circle cx={8} cy={8} r={7} fill="#f3d2b6" />
      <Circle cx={20} cy={8} r={7} fill="#f0d8d8" />
    </Svg>
  );
}

function ChevronRightIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 6L15 12L9 18"
        stroke="#a3a6ad"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function AlbumIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={4} width={18} height={15} rx={3} stroke={color} strokeWidth={2} />
      <Circle cx={8.5} cy={9} r={1.4} fill={color} />
      <Path d="M6 16L11 11.5L14.6 14.6L18 12" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function FavoriteIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7 4H17A2 2 0 0 1 19 6V20L12 16L5 20V6A2 2 0 0 1 7 4Z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Path d="M9.2 9.4H14.8" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function FileIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7A3 3 0 0 1 7 4H10.2C11 4 11.8 4.3 12.4 4.9L13.1 5.6C13.4 5.9 13.8 6 14.2 6H17A3 3 0 0 1 20 9V17A3 3 0 0 1 17 20H7A3 3 0 0 1 4 17V7Z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function WalletIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={6} width={18} height={13} rx={3} stroke={color} strokeWidth={2} />
      <Path d="M3 10H21" stroke={color} strokeWidth={2} />
      <Circle cx={15.8} cy={14.2} r={1.2} fill={color} />
    </Svg>
  );
}

function VipIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3L16.6 8.6L21 10.1L17.9 14.1L18 20L12 17.4L6 20L6.1 14.1L3 10.1L7.4 8.6L12 3Z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={11.2} r={2.2} stroke={color} strokeWidth={1.6} />
    </Svg>
  );
}

function DressIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8 4L12 6L16 4L18.5 7L15.5 9.2V19H8.5V9.2L5.5 7L8 4Z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SettingsIcon() {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9.6 3.2H14.4L15 5.6C15.6 5.8 16.2 6.1 16.8 6.5L19.1 5.4L21.5 9.5L19.5 11.1C19.5 11.4 19.6 11.7 19.6 12C19.6 12.3 19.5 12.6 19.5 12.9L21.5 14.5L19.1 18.6L16.8 17.5C16.2 17.9 15.6 18.2 15 18.4L14.4 20.8H9.6L9 18.4C8.4 18.2 7.8 17.9 7.2 17.5L4.9 18.6L2.5 14.5L4.5 12.9C4.5 12.6 4.4 12.3 4.4 12C4.4 11.7 4.5 11.4 4.5 11.1L2.5 9.5L4.9 5.4L7.2 6.5C7.8 6.1 8.4 5.8 9 5.6L9.6 3.2Z"
        stroke="#1e1f24"
        strokeWidth={1.8}
      />
      <Circle cx={12} cy={12} r={2.8} stroke="#1e1f24" strokeWidth={1.8} />
    </Svg>
  );
}

function MoonIcon() {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15.8 3.9C14.2 4.3 12.8 5.2 11.8 6.6C9.3 10.1 10.2 15 13.7 17.5C14.9 18.4 16.3 18.9 17.7 19C16.5 19.8 15 20.3 13.4 20.3C8.9 20.3 5.3 16.7 5.3 12.2C5.3 7.7 8.9 4.1 13.4 4.1C14.2 4.1 15 4.2 15.8 3.9Z"
        stroke="#1e1f24"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function MenuBarsIcon() {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Line x1={5} y1={8} x2={19} y2={8} stroke="#1e1f24" strokeWidth={2.2} strokeLinecap="round" />
      <Line x1={5} y1={12} x2={19} y2={12} stroke="#1e1f24" strokeWidth={2.2} strokeLinecap="round" />
      <Line x1={5} y1={16} x2={19} y2={16} stroke="#1e1f24" strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}

