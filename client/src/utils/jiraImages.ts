export const MAX_JIRA_IMAGES = 5;
export const MAX_JIRA_IMAGE_BYTES = 4 * 1024 * 1024;

export type PendingJiraImage = {
  id: string;
  file: File;
  previewUrl: string;
};

export type ComposerInlineImage = PendingJiraImage & {
  filename: string;
  width: number;
  align: 'left' | 'center' | 'right';
};

export const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Không đọc được ảnh.'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Không đọc được ảnh.'));
    reader.readAsDataURL(file);
  });

export async function serializeJiraImages(
  images: (PendingJiraImage & { filename?: string })[]
) {
  const payload = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    payload.push({
      filename: img.filename || img.file.name || `paste-${i + 1}.png`,
      mimeType: img.file.type || 'image/png',
      dataBase64: await fileToBase64(img.file),
    });
  }
  return payload;
}

export function revokeJiraImagePreviews(images: PendingJiraImage[]) {
  images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
}
