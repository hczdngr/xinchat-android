export type ScanMode = 'ar' | 'scan' | 'text';

export const QR_SCAN_MODE_ITEMS: ReadonlyArray<{ key: ScanMode; label: string }> = [
  { key: 'ar', label: 'AR' },
  { key: 'scan', label: '\u626b\u4e00\u626b' },
  { key: 'text', label: '\u8f6c\u6587\u5b57' },
];

export const QR_SCAN_TEXT = {
  tipAlignCode: '\u8bf7\u5bf9\u51c6\u9700\u8981\u8bc6\u522b\u7684\u4e8c\u7ef4\u7801',
  tipAlignObject: '\u5bf9\u51c6\u7269\u4f53\u540e\u70b9\u51fb\u8bc6\u522b',
  zoomHintDoubleTap: '\u53cc\u51fb\u5207\u6362 1x/2x',
  invalidScannedValue: '\u8bc6\u522b\u7ed3\u679c\u4e0d\u662f\u6709\u6548\u94fe\u63a5',
  scanResultTitle: '\u626b\u7801\u7ed3\u679c',
  albumNoQrDetected: '\u76f8\u518c\u56fe\u7247\u672a\u8bc6\u522b\u5230\u4e8c\u7ef4\u7801',
  albumNoObjectDetected: '\u76f8\u518c\u56fe\u7247\u672a\u8bc6\u522b\u5230\u660e\u786e\u7269\u4f53',
  albumOpenFailed: '\u6253\u5f00\u76f8\u518c\u5931\u8d25',
  arCaptureFailed: '\u62cd\u7167\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5',
  arRecognizeFailed: '\u7269\u4f53\u8bc6\u522b\u5931\u8d25',
  arRecognizeButton: '\u8bc6\u522b\u5f53\u524d\u753b\u9762',
  arRecognizing: '\u6b63\u5728\u8bc6\u522b...',
  arResultTitle: '\u8bc6\u522b\u7ed3\u679c',
  arNoFrame: '\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u753b\u9762',
  myQrCode: '\u6211\u7684\u4e8c\u7ef4\u7801',
  album: '\u76f8\u518c',
  albumRecognize: '\u76f8\u518c\u8bc6\u522b',
  decoding: '\u8bc6\u522b\u4e2d...',
  cameraPermissionRequired: '\u9700\u8981\u76f8\u673a\u6743\u9650\u624d\u80fd\u626b\u7801',
  grantCameraPermission: '\u6388\u6743\u76f8\u673a',
  noRearCamera: '\u672a\u627e\u5230\u540e\u7f6e\u6444\u50cf\u5934',
  cameraAccessFailed: '\u65e0\u6cd5\u8bbf\u95ee\u6444\u50cf\u5934',
} as const;

