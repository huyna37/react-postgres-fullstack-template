import { useLayoutEffect, type RefObject } from 'react';

/** Gán class + biến CSS cho layout dashboard (≤2 hàng vừa viewport). */
export function useDashboardViewportMetrics(
  mainRef: RefObject<HTMLElement | null>,
  headerRef: RefObject<HTMLElement | null>,
  gridWrapRef: RefObject<HTMLElement | null>,
  gridRef: RefObject<HTMLElement | null>,
  itemCount: number
) {
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;

    const measure = () => {
      const mainEl = mainRef.current;
      const wrapEl = gridWrapRef.current;
      const gridEl = gridRef.current;
      if (!mainEl || !wrapEl) return;

      let cols = 4;
      if (gridEl) {
        const template = getComputedStyle(gridEl).gridTemplateColumns;
        cols = template.split(' ').filter(Boolean).length || 4;
      }

      const totalRows = Math.max(1, Math.ceil(Math.max(1, itemCount) / cols));
      const fitRows = Math.min(2, totalRows);

      mainEl.style.setProperty('--dashboard-fit-rows', String(fitRows));
      mainEl.style.setProperty('--dashboard-total-rows', String(totalRows));
      mainEl.style.setProperty('--dashboard-body-px', `${wrapEl.clientHeight}px`);

      mainEl.classList.toggle('dashboard-main--fit-rows', totalRows <= 2);
      mainEl.classList.toggle('dashboard-main--scroll-rows', totalRows > 2);

      if (gridEl) {
        if (totalRows <= 2) {
          gridEl.style.gridTemplateRows = `repeat(${fitRows}, minmax(0, 1fr))`;
        } else {
          gridEl.style.gridTemplateRows = '';
        }
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    const header = headerRef.current;
    const wrap = gridWrapRef.current;
    const grid = gridRef.current;
    const shell = main.closest('.main-content');
    if (header) ro.observe(header);
    if (wrap) ro.observe(wrap);
    if (grid) ro.observe(grid);
    if (shell) ro.observe(shell);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [mainRef, headerRef, gridWrapRef, gridRef, itemCount]);
}
