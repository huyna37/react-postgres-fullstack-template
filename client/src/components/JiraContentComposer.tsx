import React, { useEffect, useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { showError } from '../utils/swal';
import {
  MAX_JIRA_IMAGE_BYTES,
  MAX_JIRA_IMAGES,
  type PendingJiraImage,
  revokeJiraImagePreviews,
} from '../utils/jiraImages';

type JiraContentComposerProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  images: PendingJiraImage[];
  onImagesChange: (images: PendingJiraImage[]) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  hint?: string;
};

export default function JiraContentComposer({
  id,
  value,
  onChange,
  images,
  onImagesChange,
  placeholder = 'Nhập nội dung hoặc Ctrl+V dán ảnh...',
  rows = 4,
  disabled = false,
  className = '',
  hint,
}: JiraContentComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);



  const addImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      showError('Chỉ hỗ trợ dán hoặc chọn file ảnh.');
      return;
    }
    if (file.size > MAX_JIRA_IMAGE_BYTES) {
      showError(`Ảnh vượt quá ${MAX_JIRA_IMAGE_BYTES / (1024 * 1024)}MB.`);
      return;
    }
    if (images.length >= MAX_JIRA_IMAGES) {
      showError(`Tối đa ${MAX_JIRA_IMAGES} ảnh.`);
      return;
    }
    const imageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    onImagesChange([...images, { id: imageId, file, previewUrl: URL.createObjectURL(file) }]);
  };

  const removeImage = (imageId: string) => {
    const target = images.find((img) => img.id === imageId);
    if (target) URL.revokeObjectURL(target.previewUrl);
    onImagesChange(images.filter((img) => img.id !== imageId));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    let hasImage = false;
    const files = e.clipboardData?.files;
    
    // First try with files which is more reliable for deduplication
    if (files && files.length > 0) {
      Array.from(files).forEach((file) => {
        if (file.type.startsWith('image/')) {
          hasImage = true;
          addImageFile(file);
        }
      });
    }
    
    // Fallback to items if files is empty
    if (!hasImage) {
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            hasImage = true;
            const file = item.getAsFile();
            if (file) addImageFile(file);
            // Break after finding one image in items to avoid duplicates if multiple formats exist
            break;
          }
        }
      }
    }

    if (hasImage) e.preventDefault();
  };

  return (
    <div className={`jira-content-composer ${className}`.trim()}>
      {hint ? <p className="jira-content-composer__hint">{hint}</p> : null}
      <textarea
        id={id}
        className="jira-content-composer__textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={handlePaste}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
      />
      {images.length > 0 && (
        <ul className="jira-content-composer__images">
          {images.map((img) => (
            <li key={img.id} className="jira-content-composer__image-item">
              <img src={img.previewUrl} alt={img.file.name || 'Ảnh đính kèm'} />
              <button
                type="button"
                className="jira-content-composer__image-remove"
                onClick={() => removeImage(img.id)}
                aria-label="Xóa ảnh"
                disabled={disabled}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="jira-content-composer__toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = e.target.files;
            if (files) Array.from(files).forEach(addImageFile);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="filter-btn jira-content-composer__attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || images.length >= MAX_JIRA_IMAGES}
        >
          <ImagePlus size={14} /> Thêm ảnh
        </button>
        <span className="jira-content-composer__paste-hint">Ctrl+V dán screenshot</span>
      </div>
    </div>
  );
}
