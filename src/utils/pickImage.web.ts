export type PickedImage = {
  path: string;
  mime: string;
  data: string;
  width: number;
  height: number;
};

export async function pickImageForPlatform(): Promise<PickedImage | null> {
  const doc = (globalThis as any).document as Document | undefined;
  if (!doc) return null;

  return new Promise((resolve, reject) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const commaIndex = dataUrl.indexOf(',');
        const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
        const ImageCtor = (globalThis as any).Image;
        if (!ImageCtor) {
          resolve({
            path: file.name || 'web-image',
            mime: file.type || 'image/jpeg',
            data: base64,
            width: 0,
            height: 0,
          });
          return;
        }
        const img = new ImageCtor();
        img.onload = () => {
          resolve({
            path: file.name || 'web-image',
            mime: file.type || 'image/jpeg',
            data: base64,
            width: Number(img.naturalWidth) || 0,
            height: Number(img.naturalHeight) || 0,
          });
        };
        img.onerror = () => reject(new Error('Load image failed'));
        img.src = dataUrl;
      };
      reader.onerror = () => reject(new Error('Read image failed'));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}
