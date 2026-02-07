import ImagePicker from 'react-native-image-crop-picker';

export type PickedImage = {
  path: string;
  mime: string;
  data: string;
  width: number;
  height: number;
};

export async function pickImagesForPlatform(maxCount = 1): Promise<PickedImage[]> {
  const safeMaxCount = Math.max(1, Math.min(9, Number(maxCount) || 1));
  const picked = await ImagePicker.openPicker({
    compressImageQuality: 0.9,
    mediaType: 'photo',
    includeBase64: true,
    multiple: safeMaxCount > 1,
    maxFiles: safeMaxCount,
  });
  const list = Array.isArray(picked) ? picked : [picked];
  return list
    .filter((item) => Boolean(item?.path))
    .slice(0, safeMaxCount)
    .map((item) => ({
      path: item.path,
      mime: item.mime || 'image/jpeg',
      data: item.data || '',
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
    }));
}

export async function pickImageForPlatform(): Promise<PickedImage | null> {
  const list = await pickImagesForPlatform(1);
  return list[0] || null;
}
