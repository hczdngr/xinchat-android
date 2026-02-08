import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

type FriendPreview = {
  uid: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  online?: boolean;
};

type GroupPreview = {
  id: number;
  name?: string;
  ownerUid?: number;
  memberUids?: number[];
  members?: FriendPreview[];
  description?: string;
  announcement?: string;
  myNickname?: string;
};

type ProfilePreview = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
};

export type RootStackParamList = {
  Home:
    | {
        openChatUid?: number;
        openChatTargetType?: 'private' | 'group';
        openChatFriend?: FriendPreview;
        openChatGroup?: GroupPreview;
        openChatFocusMessageId?: string;
      }
    | undefined;
  UserCenter:
    | {
        profile?: ProfilePreview;
      }
    | undefined;
  Profile: undefined;
  FriendProfile: {
    uid: number;
    friend?: FriendPreview;
  };
  ChatSettings: {
    uid: number;
    friend?: FriendPreview;
  };
  GroupChatSettings: {
    uid: number;
    group?: GroupPreview;
  };
  GroupChatSearch: {
    uid: number;
    title?: string;
    group?: GroupPreview;
  };
  CreateGroup:
    | {
        preselectedMemberUids?: number[];
      }
    | undefined;
  EditProfile: undefined;
  QRScan: undefined;
  InAppBrowser: {
    url: string;
    title?: string;
  };
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export type HomeRoute = RouteProp<RootStackParamList, 'Home'>;
export type UserCenterRoute = RouteProp<RootStackParamList, 'UserCenter'>;
export type FriendProfileRoute = RouteProp<RootStackParamList, 'FriendProfile'>;
export type ChatSettingsRoute = RouteProp<RootStackParamList, 'ChatSettings'>;
export type GroupChatSettingsRoute = RouteProp<RootStackParamList, 'GroupChatSettings'>;
export type GroupChatSearchRoute = RouteProp<RootStackParamList, 'GroupChatSearch'>;
export type CreateGroupRoute = RouteProp<RootStackParamList, 'CreateGroup'>;
export type InAppBrowserRoute = RouteProp<RootStackParamList, 'InAppBrowser'>;
