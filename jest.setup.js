require('react-native-gesture-handler/jestSetup');

const mockAsyncStorage = require('@react-native-async-storage/async-storage/jest/async-storage-mock');

jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);
jest.mock('react-native-image-crop-picker', () => ({
  __esModule: true,
  default: {
    openPicker: jest.fn(),
    openCamera: jest.fn(),
    openCropper: jest.fn(),
    clean: jest.fn(),
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaConsumer: ({ children }) => children(inset),
    SafeAreaView: ({ children }) => children,
    useSafeAreaInsets: () => inset,
  };
});

jest.mock('react-native-vision-camera', () => ({
  Camera: () => null,
  useCameraPermission: () => ({
    hasPermission: true,
    requestPermission: jest.fn(async () => true),
  }),
  useCameraDevice: () => ({
    id: 'mock-back-camera',
    position: 'back',
    minZoom: 1,
    maxZoom: 3,
    neutralZoom: 1,
  }),
  useCodeScanner: () => ({}),
}));

jest.mock('react-native-webview', () => ({
  WebView: () => null,
}));
