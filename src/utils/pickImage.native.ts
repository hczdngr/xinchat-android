import ImagePicker from 'react-native-image-crop-picker';

export type PickedImage = {
  path: string;
  mime: string;
  data: string;
};

export async function pickImageForPlatform(): Promise<PickedImage | null> {
  const picked = await ImagePicker.openPicker({
    width: 512,
    height: 512,
    cropping: true,
    cropperToolbarTitle: '\u88c1\u526a\u5934\u50cf',
    compressImageQuality: 0.9,
    mediaType: 'photo',
    includeBase64: true,
  });
  if (!picked?.path) return null;
  return {
    path: picked.path,
    mime: picked.mime || 'image/jpeg',
    data: picked.data || '',
  };
}
