export type PickedImage = {
  path: string;
  mime: string;
  data: string;
  width: number;
  height: number;
};

export async function pickImagesForPlatform(maxCount = 1): Promise<PickedImage[]> {
  const doc = (globalThis as any).document as Document | undefined;
  const win = (globalThis as any).window as Window | undefined;
  if (!doc || !win) return [];
  const safeMaxCount = Math.max(1, Math.min(9, Number(maxCount) || 1));

  return new Promise((resolve, reject) => {
    const input = doc.createElement('input');
    let settled = false;
    let focusTimer: number | null = null;
    const cleanup = () => {
      input.onchange = null;
      win.removeEventListener('focus', handleFocus);
      if (focusTimer) {
        win.clearTimeout(focusTimer);
        focusTimer = null;
      }
    };
    const resolveOnce = (value: PickedImage[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleFocus = () => {
      focusTimer = win.setTimeout(() => {
        if (settled) return;
        const files = input.files ? Array.from(input.files).slice(0, safeMaxCount) : [];
        if (!files.length) resolveOnce([]);
      }, 250);
    };
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = safeMaxCount > 1;
    input.onchange = () => {
      const files = input.files ? Array.from(input.files).slice(0, safeMaxCount) : [];
      if (!files.length) {
        resolveOnce([]);
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
        .then(resolveOnce)
        .catch((error) => rejectOnce(error instanceof Error ? error : new Error('Pick image failed')));
    };
    win.addEventListener('focus', handleFocus, { once: true });
    input.click();
  });
}

export async function pickImageForPlatform(): Promise<PickedImage | null> {
  const list = await pickImagesForPlatform(1);
  return list[0] || null;
}
