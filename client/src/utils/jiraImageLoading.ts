function isLocalImageSrc(src: string) {
  return src.startsWith('blob:') || src.startsWith('data:');
}

/** Gắn trạng thái loading / loaded / error cho ảnh wiki & composer. */
export function bindJiraImageLoading(img: HTMLImageElement): () => void {
  const getFrame = () =>
    img.closest('.jira-img-frame') as HTMLElement | null;

  const getComposerWrap = () =>
    img.closest('.jira-rich-composer__img-wrap') as HTMLElement | null;

  const localPreview = isLocalImageSrc(img.src || '');

  const markLoaded = () => {
    img.classList.add('is-loaded');
    const frame = getFrame();
    frame?.classList.remove('is-loading');
    frame?.classList.add('is-loaded');
    const wrap = getComposerWrap();
    wrap?.classList.remove('is-loading');
    wrap?.classList.add('is-loaded');
  };

  const markError = () => {
    if (localPreview || img.dataset.fallbackApplied) return;
    img.dataset.fallbackApplied = '1';
    img.classList.add('jira-wiki-img--broken');
    const frame = getFrame();
    frame?.classList.remove('is-loading');
    frame?.classList.add('is-error');
    const wrap = getComposerWrap();
    wrap?.classList.remove('is-loading');
    wrap?.classList.add('is-error');
    if (img.alt && !img.alt.includes('không tải được')) {
      img.alt = `${img.alt} (không tải được — kiểm tra Jira Token)`;
    }
  };

  const onLoad = () => markLoaded();
  const onError = () => markError();

  img.addEventListener('load', onLoad);
  img.addEventListener('error', onError);

  if (img.complete && img.naturalWidth > 0) {
    markLoaded();
  } else if (img.complete && img.src && !localPreview) {
    markError();
  } else {
    getFrame()?.classList.add('is-loading');
    getComposerWrap()?.classList.add('is-loading');
  }

  return () => {
    img.removeEventListener('load', onLoad);
    img.removeEventListener('error', onError);
  };
}

export function bindJiraImagesInRoot(root: HTMLElement): () => void {
  const selector =
    'img.jira-wiki-img, .jira-rich-composer__img-wrap img, .jira-loading-image__img';
  const imgs = root.querySelectorAll<HTMLImageElement>(selector);
  const unbind = Array.from(imgs).map(bindJiraImageLoading);
  return () => unbind.forEach(fn => fn());
}

export function wrapWikiImageMarkup(imgHtml: string): string {
  return `<span class="jira-img-frame is-loading"><span class="jira-img-frame__shimmer" aria-hidden="true"></span><span class="jira-img-frame__spinner" aria-hidden="true"></span>${imgHtml}</span>`;
}

export function decorateComposerImageWrap(
  wrap: HTMLElement,
  imageEl: HTMLImageElement,
  opts?: { localPreview?: boolean }
) {
  const localPreview = opts?.localPreview || isLocalImageSrc(imageEl.src || '');
  wrap.classList.add('is-loading');
  if (!wrap.querySelector('.jira-img-frame__shimmer')) {
    const shimmer = document.createElement('span');
    shimmer.className = 'jira-img-frame__shimmer';
    shimmer.setAttribute('aria-hidden', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'jira-img-frame__spinner';
    spinner.setAttribute('aria-hidden', 'true');
    wrap.insertBefore(spinner, imageEl);
    wrap.insertBefore(shimmer, imageEl);
  }
  if (localPreview) {
    const markLoaded = () => {
      wrap.classList.remove('is-loading');
      wrap.classList.add('is-loaded');
    };
    imageEl.addEventListener('load', markLoaded, { once: true });
    imageEl.addEventListener(
      'error',
      () => {
        wrap.classList.remove('is-loading');
        wrap.classList.add('is-error');
      },
      { once: true }
    );
    if (imageEl.complete && imageEl.naturalWidth > 0) markLoaded();
    return;
  }
  bindJiraImageLoading(imageEl);
}
