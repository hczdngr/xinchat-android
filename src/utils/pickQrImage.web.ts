export type PickedQrImage = {
  path: string;
  mime: string;
  data: string;
};

export async function pickQrImageForPlatform(): Promise<PickedQrImage | null> {
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
        resolve({
          path: file.name || 'web-image',
          mime: file.type || 'image/jpeg',
          data: base64,
        });
      };
      reader.onerror = () => reject(new Error('Read image failed'));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}
