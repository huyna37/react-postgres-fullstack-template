import { useEffect, useState } from 'react';

export const MODAL_EXIT_MS = 220;

/** Giữ nội dung mount thêm một nhịp sau khi `open` = false (animation đóng modal). */
export function useDeferredUnmount(open: boolean, exitMs = MODAL_EXIT_MS): boolean {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);

  return mounted;
}
