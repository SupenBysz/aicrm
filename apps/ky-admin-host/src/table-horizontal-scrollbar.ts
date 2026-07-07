import { useEffect } from "react";

const HOST_CLASS = "admin-table-scrollbar-host";
const SCROLLBAR_CLASS = "admin-table-horizontal-scrollbar";
const THUMB_CLASS = "admin-table-horizontal-scrollbar-thumb";
const DRAGGING_CLASS = "admin-table-scrollbar-dragging";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function useTableHorizontalScrollbars() {
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const root = document.querySelector(".app-shell") ?? document.body;
    const cleanups = new Map<HTMLElement, () => void>();
    let installFrame = 0;

    const installTableScrollbar = (wrapper: HTMLElement) => {
      if (cleanups.has(wrapper)) return;

      const table = wrapper.querySelector<HTMLElement>(".ant-table");
      const content = wrapper.querySelector<HTMLElement>(".ant-table-content");
      if (!table || !content) return;

      wrapper.classList.add(HOST_CLASS);

      let scrollbar = table.querySelector<HTMLElement>(`:scope > .${SCROLLBAR_CLASS}`);
      if (!scrollbar) {
        scrollbar = document.createElement("div");
        scrollbar.className = SCROLLBAR_CLASS;
        scrollbar.setAttribute("aria-hidden", "true");

        const thumb = document.createElement("div");
        thumb.className = THUMB_CLASS;
        scrollbar.appendChild(thumb);
        table.appendChild(scrollbar);
      }

      const thumb = scrollbar.querySelector<HTMLElement>(`.${THUMB_CLASS}`);
      if (!thumb) return;

      let updateFrame = 0;

      const update = () => {
        updateFrame = 0;

        const clientWidth = content.clientWidth;
        const scrollWidth = content.scrollWidth;
        const hasOverflow = scrollWidth > clientWidth + 1;

        wrapper.dataset.tableOverflowX = hasOverflow ? "true" : "false";
        if (!hasOverflow || clientWidth <= 0 || scrollWidth <= 0) {
          scrollbar.style.setProperty("--admin-table-scrollbar-thumb-left", "0px");
          scrollbar.style.setProperty("--admin-table-scrollbar-thumb-width", "0px");
          return;
        }

        const trackWidth = scrollbar.clientWidth;
        const thumbWidth = Math.max(42, Math.round((clientWidth / scrollWidth) * trackWidth));
        const maxScrollLeft = Math.max(1, scrollWidth - clientWidth);
        const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
        const thumbLeft = Math.round((content.scrollLeft / maxScrollLeft) * maxThumbLeft);

        scrollbar.style.setProperty("--admin-table-scrollbar-thumb-left", `${thumbLeft}px`);
        scrollbar.style.setProperty("--admin-table-scrollbar-thumb-width", `${thumbWidth}px`);
      };

      const scheduleUpdate = () => {
        if (updateFrame) return;
        updateFrame = window.requestAnimationFrame(update);
      };

      const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleUpdate) : null;
      resizeObserver?.observe(table);
      resizeObserver?.observe(content);
      const tableElement = content.querySelector("table");
      if (tableElement) resizeObserver?.observe(tableElement);

      const handlePointerDown = (event: PointerEvent) => {
        const clientWidth = content.clientWidth;
        const scrollWidth = content.scrollWidth;
        if (scrollWidth <= clientWidth + 1) return;

        event.preventDefault();
        event.stopPropagation();

        const trackRect = scrollbar.getBoundingClientRect();
        const thumbWidth = thumb.getBoundingClientRect().width;
        const maxThumbLeft = Math.max(1, trackRect.width - thumbWidth);
        const maxScrollLeft = Math.max(1, scrollWidth - clientWidth);

        let startClientX = event.clientX;
        let startScrollLeft = content.scrollLeft;

        if (event.target !== thumb) {
          const nextThumbLeft = clamp(event.clientX - trackRect.left - thumbWidth / 2, 0, maxThumbLeft);
          content.scrollLeft = (nextThumbLeft / maxThumbLeft) * maxScrollLeft;
          startClientX = event.clientX;
          startScrollLeft = content.scrollLeft;
          scheduleUpdate();
        }

        document.documentElement.classList.add(DRAGGING_CLASS);
        scrollbar.setPointerCapture?.(event.pointerId);

        const handlePointerMove = (moveEvent: PointerEvent) => {
          const deltaX = moveEvent.clientX - startClientX;
          content.scrollLeft = clamp(startScrollLeft + (deltaX / maxThumbLeft) * maxScrollLeft, 0, maxScrollLeft);
          scheduleUpdate();
        };

        const stopDragging = (upEvent: PointerEvent) => {
          document.documentElement.classList.remove(DRAGGING_CLASS);
          scrollbar.releasePointerCapture?.(upEvent.pointerId);
          window.removeEventListener("pointermove", handlePointerMove);
          window.removeEventListener("pointerup", stopDragging);
          window.removeEventListener("pointercancel", stopDragging);
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);
      };

      content.addEventListener("scroll", scheduleUpdate, { passive: true });
      scrollbar.addEventListener("pointerdown", handlePointerDown);
      window.addEventListener("resize", scheduleUpdate);
      scheduleUpdate();

      cleanups.set(wrapper, () => {
        wrapper.classList.remove(HOST_CLASS);
        delete wrapper.dataset.tableOverflowX;
        content.removeEventListener("scroll", scheduleUpdate);
        scrollbar.removeEventListener("pointerdown", handlePointerDown);
        window.removeEventListener("resize", scheduleUpdate);
        resizeObserver?.disconnect();
        if (updateFrame) window.cancelAnimationFrame(updateFrame);
        scrollbar.remove();
      });
    };

    const installAll = () => {
      installFrame = 0;
      cleanups.forEach((cleanup, wrapper) => {
        if (wrapper.isConnected) return;
        cleanup();
        cleanups.delete(wrapper);
      });
      root.querySelectorAll<HTMLElement>(".ant-table-wrapper").forEach(installTableScrollbar);
    };

    const scheduleInstall = () => {
      if (installFrame) return;
      installFrame = window.requestAnimationFrame(installAll);
    };

    const mutationObserver = new MutationObserver(scheduleInstall);
    mutationObserver.observe(root, { childList: true, subtree: true });
    scheduleInstall();

    return () => {
      mutationObserver.disconnect();
      if (installFrame) window.cancelAnimationFrame(installFrame);
      cleanups.forEach((cleanup) => cleanup());
      cleanups.clear();
      document.documentElement.classList.remove(DRAGGING_CLASS);
    };
  }, []);
}
