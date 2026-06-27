import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Trash2,
  X,
} from 'lucide-react';
import { showError } from '../utils/swal';
import {
  MAX_JIRA_IMAGE_BYTES,
  MAX_JIRA_IMAGES,
  type ComposerInlineImage,
  revokeJiraImagePreviews,
} from '../utils/jiraImages';
import { decorateComposerImageWrap } from '../utils/jiraImageLoading';
import {
  DEFAULT_INLINE_IMAGE_WIDTH,
  exportEditorToJiraWiki,
  hydrateEditorFromWiki,
  imageFilenameForId,
  MAX_INLINE_IMAGE_WIDTH,
  MIN_INLINE_IMAGE_WIDTH,
  type ImageAlign,
} from '../utils/jiraRichComposer';

type JiraRichComposerProps = {
  id?: string;
  wiki: string;
  images: ComposerInlineImage[];
  onChange: (payload: { wiki: string; images: ComposerInlineImage[] }) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  hint?: string;
  minHeight?: number;
  issueKey?: string;
  apiBaseUrl?: string;
  onCommit?: (payload: { wiki: string; images: ComposerInlineImage[] }) => void;
};

function createImageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampWidth(width: number) {
  return Math.min(MAX_INLINE_IMAGE_WIDTH, Math.max(MIN_INLINE_IMAGE_WIDTH, Math.round(width)));
}

function wrapSelectionKey(wrap: HTMLElement) {
  if (wrap.dataset.imageId) return wrap.dataset.imageId;
  if (wrap.dataset.existingFilename) return `existing:${wrap.dataset.existingFilename}`;
  return null;
}

function findWrapByKey(editor: HTMLElement, key: string) {
  if (key.startsWith('existing:')) {
    const filename = key.slice('existing:'.length);
    return editor.querySelector(
      `.jira-rich-composer__img-wrap[data-existing-filename="${CSS.escape(filename)}"]`
    ) as HTMLElement | null;
  }
  return editor.querySelector(
    `.jira-rich-composer__img-wrap[data-image-id="${CSS.escape(key)}"]`
  ) as HTMLElement | null;
}

function readWrapMeta(wrap: HTMLElement) {
  const imgEl = wrap.querySelector('img') as HTMLImageElement | null;
  const width = clampWidth(
    parseFloat(imgEl?.style.width || '') ||
      parseFloat(wrap.dataset.width || '') ||
      DEFAULT_INLINE_IMAGE_WIDTH
  );
  const align = (wrap.dataset.align as ImageAlign) || 'center';
  return { width, align };
}

export default function JiraRichComposer({
  id,
  wiki,
  images,
  onChange,
  placeholder = 'Mô tả chi tiết — chèn ảnh, chỉnh kích thước & căn lề như CKEditor',
  disabled = false,
  className = '',
  hint,
  minHeight = 180,
  issueKey,
  apiBaseUrl,
  onCommit,
}: JiraRichComposerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const onCommitRef = useRef(onCommit);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  const selectedWrapKeyRef = useRef<string | null>(null);
  const resizeStateRef = useRef<{ wrapKey: string; startX: number; startWidth: number } | null>(
    null
  );
  const [selectedWrapKey, setSelectedWrapKey] = useState<string | null>(null);
  const [selectedExistingMeta, setSelectedExistingMeta] = useState<{
    filename: string;
    width: number;
    align: ImageAlign;
  } | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);



  const markEditorTouched = useCallback(() => {
    const editor = editorRef.current;
    if (editor) editor.dataset.hydrated = '1';
  }, []);

  const syncFromEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    markEditorTouched();
    const exported = exportEditorToJiraWiki(editor, imagesRef.current);
    onChange(exported);
    const hasText = (editor.textContent || '').trim().length > 0;
    const hasImg = editor.querySelector('.jira-rich-composer__img-wrap') !== null;
    setIsEmpty(!hasText && !hasImg);
  }, [markEditorTouched, onChange]);

  const selectWrap = useCallback((wrapKey: string | null) => {
    selectedWrapKeyRef.current = wrapKey;
    setSelectedWrapKey(wrapKey);
    const editor = editorRef.current;
    if (!editor) return;
    editor.querySelectorAll('.jira-rich-composer__img-wrap.is-selected').forEach(el => {
      el.classList.remove('is-selected');
    });
    if (!wrapKey) {
      setSelectedExistingMeta(null);
      return;
    }
    const wrap = findWrapByKey(editor, wrapKey);
    wrap?.classList.add('is-selected');
    if (wrap?.dataset.existingFilename) {
      const meta = readWrapMeta(wrap);
      setSelectedExistingMeta({
        filename: wrap.dataset.existingFilename,
        width: meta.width,
        align: meta.align,
      });
    } else {
      setSelectedExistingMeta(null);
    }
  }, []);

  const buildImageWrap = useCallback((img: ComposerInlineImage) => {
    const wrap = document.createElement('div');
    wrap.className = 'jira-rich-composer__img-wrap';
    wrap.contentEditable = 'false';
    wrap.dataset.imageId = img.id;
    wrap.dataset.align = img.align;
    wrap.dataset.width = String(img.width);
    wrap.classList.add(`is-align-${img.align}`);

    const imageEl = document.createElement('img');
    imageEl.src = img.previewUrl;
    imageEl.alt = img.file.name || 'Ảnh đính kèm';
    imageEl.draggable = false;
    imageEl.style.width = `${img.width}px`;

    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'jira-rich-composer__resize-handle';
    resizeHandle.title = 'Kéo để đổi kích thước';

    wrap.append(imageEl, resizeHandle);
    decorateComposerImageWrap(wrap, imageEl, { localPreview: true });
    return wrap;
  }, []);

  const insertNodeAtCaret = useCallback((node: Node) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      editor.appendChild(node);
      return;
    }
    let range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(node);
    const spacer = document.createTextNode('\u00A0');
    range.setStartAfter(node);
    range.collapse(true);
    range.insertNode(spacer);
    range.setStartAfter(spacer);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const addImageFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        showError('Chỉ hỗ trợ dán hoặc chọn file ảnh.');
        return;
      }
      if (file.size > MAX_JIRA_IMAGE_BYTES) {
        showError(`Ảnh vượt quá ${MAX_JIRA_IMAGE_BYTES / (1024 * 1024)}MB.`);
        return;
      }
      if (imagesRef.current.length >= MAX_JIRA_IMAGES) {
        showError(`Tối đa ${MAX_JIRA_IMAGES} ảnh.`);
        return;
      }

      const imageId = createImageId();
      const next: ComposerInlineImage = {
        id: imageId,
        file,
        previewUrl: URL.createObjectURL(file),
        filename: imageFilenameForId(imageId, file.type),
        width: DEFAULT_INLINE_IMAGE_WIDTH,
        align: 'center',
      };
      const wrap = buildImageWrap(next);
      insertNodeAtCaret(wrap);
      const nextImages = [...imagesRef.current, next];
      imagesRef.current = nextImages;
      markEditorTouched();
      onChange(exportEditorToJiraWiki(editorRef.current!, nextImages));
      setIsEmpty(false);
      selectWrap(imageId);
    },
    [buildImageWrap, insertNodeAtCaret, markEditorTouched, onChange, selectWrap]
  );

  const applyWrapMeta = useCallback(
    (wrap: HTMLElement, patch: Partial<{ width: number; align: ImageAlign }>) => {
      const imgEl = wrap.querySelector('img') as HTMLImageElement | null;
      const current = readWrapMeta(wrap);
      const width = patch.width !== undefined ? clampWidth(patch.width) : current.width;
      const align = patch.align ?? current.align;
      wrap.dataset.align = align;
      wrap.dataset.width = String(width);
      wrap.classList.remove('is-align-left', 'is-align-center', 'is-align-right');
      wrap.classList.add(`is-align-${align}`);
      if (imgEl) imgEl.style.width = `${width}px`;
      return { width, align };
    },
    []
  );

  const removeWrap = useCallback(
    (wrapKey: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      const wrap = findWrapByKey(editor, wrapKey);
      wrap?.remove();
      if (!wrapKey.startsWith('existing:')) {
        const target = imagesRef.current.find(img => img.id === wrapKey);
        if (target) URL.revokeObjectURL(target.previewUrl);
        const nextImages = imagesRef.current.filter(img => img.id !== wrapKey);
        imagesRef.current = nextImages;
        onChange(exportEditorToJiraWiki(editor, nextImages));
      } else {
        onChange(exportEditorToJiraWiki(editor, imagesRef.current));
      }
      if (selectedWrapKeyRef.current === wrapKey) selectWrap(null);
      syncFromEditor();
    },
    [onChange, selectWrap, syncFromEditor]
  );

  const updateImageMeta = useCallback(
    (imageId: string, patch: Partial<Pick<ComposerInlineImage, 'width' | 'align'>>) => {
      const editor = editorRef.current;
      if (!editor) return;
      const wrap = findWrapByKey(editor, imageId);
      if (!wrap) return;
      const imgEl = wrap.querySelector('img') as HTMLImageElement | null;
      const nextImages = imagesRef.current.map(item => {
        if (item.id !== imageId) return item;
        const { width, align } = applyWrapMeta(wrap, patch);
        if (imgEl) imgEl.style.width = `${width}px`;
        return { ...item, width, align };
      });
      imagesRef.current = nextImages;
      onChange(exportEditorToJiraWiki(editor, nextImages));
    },
    [applyWrapMeta, onChange]
  );

  const updateExistingImageMeta = useCallback(
    (filename: string, patch: Partial<{ width: number; align: ImageAlign }>) => {
      const editor = editorRef.current;
      if (!editor) return;
      const wrap = findWrapByKey(editor, `existing:${filename}`);
      if (!wrap) return;
      const meta = applyWrapMeta(wrap, patch);
      setSelectedExistingMeta({ filename, width: meta.width, align: meta.align });
      onChange(exportEditorToJiraWiki(editor, imagesRef.current));
    },
    [applyWrapMeta, onChange]
  );

  const execFormat = (command: string, value?: string) => {
    if (disabled) return;
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    syncFromEditor();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    let pastedImage = false;
    const files = e.clipboardData?.files;
    
    // First try with files which is more reliable for deduplication
    if (files && files.length > 0) {
      Array.from(files).forEach((file) => {
        if (file.type.startsWith('image/')) {
          pastedImage = true;
          addImageFile(file);
        }
      });
    }
    
    // Fallback to items if files is empty
    if (!pastedImage) {
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            pastedImage = true;
            const file = item.getAsFile();
            if (file) addImageFile(file);
            // Break after finding one image in items to avoid duplicates if multiple formats exist
            break;
          }
        }
      }
    }

    if (pastedImage) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
    syncFromEditor();
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state) return;
      const delta = e.clientX - state.startX;
      const editor = editorRef.current;
      const wrap = editor ? findWrapByKey(editor, state.wrapKey) : null;
      if (!wrap) return;
      const nextWidth = state.startWidth + delta;
      if (state.wrapKey.startsWith('existing:')) {
        const filename = state.wrapKey.slice('existing:'.length);
        updateExistingImageMeta(filename, { width: nextWidth });
      } else {
        updateImageMeta(state.wrapKey, { width: nextWidth });
      }
    };
    const onMouseUp = () => {
      resizeStateRef.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [updateExistingImageMeta, updateImageMeta]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const onEditorClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const wrap = target.closest('.jira-rich-composer__img-wrap') as HTMLElement | null;
      const wrapKey = wrap ? wrapSelectionKey(wrap) : null;
      if (wrapKey) {
        e.preventDefault();
        selectWrap(wrapKey);
        return;
      }
      if (!target.closest('.jira-rich-composer__image-toolbar')) {
        selectWrap(null);
      }
    };

    const onImageMouseDown = (e: MouseEvent) => {
      const wrap = (e.target as HTMLElement).closest('.jira-rich-composer__img-wrap');
      if (wrap) e.preventDefault();
    };

    const onEditorInput = () => syncFromEditor();

    const onResizeStart = (e: MouseEvent) => {
      const handle = (e.target as HTMLElement).closest('.jira-rich-composer__resize-handle');
      if (!handle) return;
      const wrap = handle.closest('.jira-rich-composer__img-wrap') as HTMLElement | null;
      const wrapKey = wrap ? wrapSelectionKey(wrap) : null;
      if (!wrap || !wrapKey) return;
      e.preventDefault();
      const meta = readWrapMeta(wrap);
      resizeStateRef.current = { wrapKey, startX: e.clientX, startWidth: meta.width };
      selectWrap(wrapKey);
    };

    editor.addEventListener('click', onEditorClick);
    editor.addEventListener('input', onEditorInput);
    editor.addEventListener('mousedown', onResizeStart);
    editor.addEventListener('mousedown', onImageMouseDown);
    return () => {
      editor.removeEventListener('click', onEditorClick);
      editor.removeEventListener('input', onEditorInput);
      editor.removeEventListener('mousedown', onResizeStart);
      editor.removeEventListener('mousedown', onImageMouseDown);
    };
  }, [selectWrap, syncFromEditor]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.dataset.hydrated === '1') return;
    if (!wiki.trim()) return;
    hydrateEditorFromWiki(editor, wiki, { issueKey, apiBaseUrl, images });
    editor.dataset.hydrated = '1';
    const hasText = (editor.textContent || '').trim().length > 0;
    const hasImg = editor.querySelector('.jira-rich-composer__img-wrap') !== null;
    setIsEmpty(!hasText && !hasImg);
  }, [wiki, issueKey, apiBaseUrl, images]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (wiki.trim() || images.length > 0) return;
    const hasDomContent =
      (editor.textContent || '').trim().length > 0 ||
      editor.querySelector('.jira-rich-composer__img-wrap') !== null;
    if (!hasDomContent) {
      setIsEmpty(true);
      return;
    }
    editor.innerHTML = '';
    delete editor.dataset.hydrated;
    selectWrap(null);
    setIsEmpty(true);
  }, [wiki, images, selectWrap]);

  useEffect(() => {
    if (!onCommit) return;
    const onPointerDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      const editor = editorRef.current;
      if (!editor) return;
      const exported = exportEditorToJiraWiki(editor, imagesRef.current);
      onChange(exported);
      window.setTimeout(() => onCommitRef.current?.(exported), 0);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onChange, onCommit]);

  const selectedImage =
    selectedWrapKey && !selectedWrapKey.startsWith('existing:')
      ? images.find(img => img.id === selectedWrapKey) || null
      : null;
  const showImageToolbar = selectedImage || selectedExistingMeta;

  return (
    <div ref={rootRef} className={`jira-rich-composer ${className}`.trim()}>
      {hint ? <p className="jira-rich-composer__hint">{hint}</p> : null}

      <div className="jira-rich-composer__toolbar" role="toolbar" aria-label="Định dạng mô tả">
        <button
          type="button"
          className="jira-rich-composer__tool-btn"
          onClick={() => execFormat('bold')}
          disabled={disabled}
          title="In đậm"
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          className="jira-rich-composer__tool-btn"
          onClick={() => execFormat('italic')}
          disabled={disabled}
          title="In nghiêng"
        >
          <Italic size={14} />
        </button>
        <button
          type="button"
          className="jira-rich-composer__tool-btn"
          onClick={() => execFormat('insertUnorderedList')}
          disabled={disabled}
          title="Danh sách bullet"
        >
          <List size={14} />
        </button>
        <button
          type="button"
          className="jira-rich-composer__tool-btn"
          onClick={() => execFormat('insertOrderedList')}
          disabled={disabled}
          title="Danh sách số"
        >
          <ListOrdered size={14} />
        </button>
        <span className="jira-rich-composer__toolbar-sep" />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={e => {
            const files = e.target.files;
            if (files) Array.from(files).forEach(addImageFile);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="jira-rich-composer__tool-btn jira-rich-composer__tool-btn--attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || images.length >= MAX_JIRA_IMAGES}
          title="Chèn ảnh"
        >
          <ImagePlus size={14} />
          <span>Ảnh</span>
        </button>
        <span className="jira-rich-composer__paste-hint">Ctrl+V dán screenshot vào vị trí con trỏ</span>
      </div>

      {showImageToolbar ? (
        <div className="jira-rich-composer__image-toolbar">
          <span className="jira-rich-composer__image-toolbar-label">Ảnh đang chọn</span>
          {(() => {
            const align = selectedImage?.align ?? selectedExistingMeta?.align ?? 'center';
            const width = selectedImage?.width ?? selectedExistingMeta?.width ?? DEFAULT_INLINE_IMAGE_WIDTH;
            const onAlign = (next: ImageAlign) => {
              if (selectedImage) updateImageMeta(selectedImage.id, { align: next });
              else if (selectedExistingMeta)
                updateExistingImageMeta(selectedExistingMeta.filename, { align: next });
            };
            const onWidth = (next: number) => {
              if (selectedImage) updateImageMeta(selectedImage.id, { width: next });
              else if (selectedExistingMeta)
                updateExistingImageMeta(selectedExistingMeta.filename, { width: next });
            };
            const onRemove = () => {
              if (selectedImage) removeWrap(selectedImage.id);
              else if (selectedExistingMeta && selectedWrapKey) removeWrap(selectedWrapKey);
            };
            return (
              <>
                <button
                  type="button"
                  className={`jira-rich-composer__tool-btn${align === 'left' ? ' is-active' : ''}`}
                  onClick={() => onAlign('left')}
                  disabled={disabled}
                  title="Căn trái"
                >
                  <AlignLeft size={14} />
                </button>
                <button
                  type="button"
                  className={`jira-rich-composer__tool-btn${align === 'center' ? ' is-active' : ''}`}
                  onClick={() => onAlign('center')}
                  disabled={disabled}
                  title="Căn giữa"
                >
                  <AlignCenter size={14} />
                </button>
                <button
                  type="button"
                  className={`jira-rich-composer__tool-btn${align === 'right' ? ' is-active' : ''}`}
                  onClick={() => onAlign('right')}
                  disabled={disabled}
                  title="Căn phải"
                >
                  <AlignRight size={14} />
                </button>
                <span className="jira-rich-composer__toolbar-sep" />
                {[280, 420, 560].map(size => (
                  <button
                    key={size}
                    type="button"
                    className={`jira-rich-composer__size-btn${width === size ? ' is-active' : ''}`}
                    onClick={() => onWidth(size)}
                    disabled={disabled}
                  >
                    {size}px
                  </button>
                ))}
                <button
                  type="button"
                  className="jira-rich-composer__tool-btn jira-rich-composer__tool-btn--danger"
                  onClick={onRemove}
                  disabled={disabled}
                  title="Xóa ảnh"
                >
                  <Trash2 size={14} />
                </button>
              </>
            );
          })()}
        </div>
      ) : null}

      <div className="jira-rich-composer__editor-wrap">
        {isEmpty ? (
          <div className="jira-rich-composer__placeholder" aria-hidden>
            {placeholder}
          </div>
        ) : null}
        <div
          id={id}
          ref={editorRef}
          className="jira-rich-composer__editor"
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-placeholder={placeholder}
          style={{ minHeight }}
          onPaste={handlePaste}
          onBlur={syncFromEditor}
        />
      </div>

      {images.length > 0 ? (
        <div className="jira-rich-composer__meta">
          {images.map(img => (
            <span key={img.id} className="jira-rich-composer__meta-chip">
              {img.filename} · {img.width}px · {img.align}
              <button
                type="button"
                onClick={() => removeWrap(img.id)}
                disabled={disabled}
                aria-label={`Xóa ${img.filename}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
