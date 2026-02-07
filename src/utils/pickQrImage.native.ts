import ImagePicker from 'react-native-image-crop-picker';

export type PickedQrImage = {
  path: string;
  mime: string;
  data: string;
};

export async function pickQrImageForPlatform(): Promise<PickedQrImage | null> {
  const picked = await ImagePicker.openPicker({
    mediaType: 'photo',
    includeBase64: true,
    compressImageQuality: 0.9,
    compressImageMaxWidth: 2048,
    compressImageMaxHeight: 2048,
    forceJpg: true,
    cropping: false,
  });

  if (!picked?.path) return null;
  return {
    path: picked.path,
    mime: picked.mime || 'image/jpeg',
    data: picked.data || '',
  };
}
