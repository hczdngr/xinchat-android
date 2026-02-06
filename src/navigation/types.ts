import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';

export type RootStackParamList = {
  Home: undefined;
  Profile: undefined;
  EditProfile: undefined;
  QRScan: undefined;
  InAppBrowser: {
    url: string;
    title?: string;
  };
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export type InAppBrowserRoute = RouteProp<RootStackParamList, 'InAppBrowser'>;
