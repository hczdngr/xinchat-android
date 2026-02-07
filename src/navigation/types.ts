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
};

export type RootStackParamList = {
  Home:
    | {
        openChatUid?: number;
        openChatTargetType?: 'private' | 'group';
        openChatFriend?: FriendPreview;
        openChatGroup?: GroupPreview;
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
export type FriendProfileRoute = RouteProp<RootStackParamList, 'FriendProfile'>;
export type ChatSettingsRoute = RouteProp<RootStackParamList, 'ChatSettings'>;
export type CreateGroupRoute = RouteProp<RootStackParamList, 'CreateGroup'>;
export type InAppBrowserRoute = RouteProp<RootStackParamList, 'InAppBrowser'>;
