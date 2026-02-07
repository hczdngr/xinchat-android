import ImagePicker from 'react-native-image-crop-picker';

export type PickedImage = {
  path: string;
  mime: string;
  data: string;
  width: number;
  height: number;
};

export async function pickImageForPlatform(): Promise<PickedImage | null> {
  const picked = await ImagePicker.openPicker({
    compressImageQuality: 0.9,
    mediaType: 'photo',
    includeBase64: true,
  });
  if (!picked?.path) return null;
  return {
    path: picked.path,
    mime: picked.mime || 'image/jpeg',
    data: picked.data || '',
    width: Number(picked.width) || 0,
    height: Number(picked.height) || 0,
  };
}
