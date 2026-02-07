export type PickedImage = {
  path: string;
  mime: string;
  data: string;
  width: number;
  height: number;
};

export async function pickImagesForPlatform(maxCount = 1): Promise<PickedImage[]> {
  const doc = (globalThis as any).document as Document | undefined;
  if (!doc) return [];
  const safeMaxCount = Math.max(1, Math.min(9, Number(maxCount) || 1));

  return new Promise((resolve, reject) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = safeMaxCount > 1;
    input.onchange = () => {
      const files = input.files ? Array.from(input.files).slice(0, safeMaxCount) : [];
      if (!files.length) {
        resolve([]);
        return;
      }
      Promise.all(
        files.map(
          (file) =>
            new Promise<PickedImage>((resolveItem, rejectItem) => {
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = String(reader.result || '');
                const commaIndex = dataUrl.indexOf(',');
                const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
                const ImageCtor = (globalThis as any).Image;
                if (!ImageCtor) {
                  resolveItem({
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
                  resolveItem({
                    path: file.name || 'web-image',
                    mime: file.type || 'image/jpeg',
                    data: base64,
                    width: Number(img.naturalWidth) || 0,
                    height: Number(img.naturalHeight) || 0,
                  });
                };
                img.onerror = () => rejectItem(new Error('Load image failed'));
                img.src = dataUrl;
              };
              reader.onerror = () => rejectItem(new Error('Read image failed'));
              reader.readAsDataURL(file);
            })
        )
      )
        .then(resolve)
        .catch(reject);
    };
    input.click();
  });
}

export async function pickImageForPlatform(): Promise<PickedImage | null> {
  const list = await pickImagesForPlatform(1);
  return list[0] || null;
}
