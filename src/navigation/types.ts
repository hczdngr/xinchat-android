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

type DetectObjectPreview = {
  name?: string;
  confidence?: number;
  attributes?: string;
  position?: string;
};

export type RootStackParamList = {
  Home:
    | {
        openChatUid?: number;
        openChatTargetType?: 'private' | 'group';
        openChatFriend?: FriendPreview;
        openChatGroup?: GroupPreview;
        openChatFocusMessageId?: string;
        openChatReturnToPrevious?: boolean;
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
    targetType?: 'private' | 'group';
    friend?: FriendPreview;
    group?: GroupPreview;
  };
  CreateGroup:
    | {
        preselectedMemberUids?: number[];
      }
    | undefined;
  EditProfile: undefined;
  QRScan: undefined;
  ObjectInsight: {
    query: string;
    imageUri?: string;
    detectSummary?: string;
    detectScene?: string;
    detectObjects?: DetectObjectPreview[];
  };
  InAppBrowser: {
    url: string;
    title?: string;
  };
  Translation: {
    textToTranslate: string;
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
export type ObjectInsightRoute = RouteProp<RootStackParamList, 'ObjectInsight'>;
export type InAppBrowserRoute = RouteProp<RootStackParamList, 'InAppBrowser'>;
