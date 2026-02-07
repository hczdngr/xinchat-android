export type CroppedImage = {
  path: string;
  mime: string;
  data: string;
  width: number;
  height: number;
};

export async function cropImageForPlatform(_path: string): Promise<CroppedImage | null> {
  return null;
}
