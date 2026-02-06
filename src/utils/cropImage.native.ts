import ImagePicker from 'react-native-image-crop-picker';

export type CroppedImage = {
  path: string;
  mime: string;
  data: string;
  width: number;
  height: number;
};

export async function cropImageForPlatform(path: string): Promise<CroppedImage | null> {
  if (!path) return null;
  const cropped = await ImagePicker.openCropper({
    path,
    width: 512,
    height: 512,
    cropping: true,
    cropperToolbarTitle: '\u88c1\u526a\u5934\u50cf',
    includeBase64: true,
    compressImageQuality: 0.92,
    mediaType: 'photo',
  });
  if (!cropped?.path) return null;
  return {
    path: cropped.path,
    mime: cropped.mime || 'image/jpeg',
    data: cropped.data || '',
    width: Number(cropped.width) || 0,
    height: Number(cropped.height) || 0,
  };
}
