import { VIEWPORT_LAYOUT_EVENT } from "./board_viewport.js";
import { currentAdminToken, isAdminPath } from "./cloudflare_socket_adapter.js";

/** @param {string} key @param {string} fallback */
function t(key, fallback) {
  try {
    const catalog = JSON.parse(
      document.getElementById("translations")?.textContent || "{}",
    );
    return catalog[key] || fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {HTMLElement | null} element
 * @param {() => void | Promise<void>} callback
 */
function activateWithKeyboard(element, callback) {
  element?.addEventListener("click", callback);
  element?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    callback();
  });
}

/**
 * @param {string} backend
 * @param {string} boardName
 */
export function adminDataEndpoint(backend, boardName) {
  const dataOrigin = new URL(backend);
  if (dataOrigin.protocol === "wss:") dataOrigin.protocol = "https:";
  if (dataOrigin.protocol === "ws:") dataOrigin.protocol = "http:";
  if (dataOrigin.protocol !== "https:" && dataOrigin.protocol !== "http:") {
    throw new Error("Unsupported administrator data endpoint protocol.");
  }
  return `${dataOrigin.href.replace(/\/$/, "")}/api/admin/boards/${encodeURIComponent(boardName)}`;
}

function installAdminDataControls() {
  if (!isAdminPath(location.pathname)) return;
  const backend = /** @type {HTMLMetaElement | null} */ (
    document.querySelector('meta[name="bwa-cloudflare-backend"]')
  )?.content?.replace(/\/$/, "");
  const pathSegments = location.pathname.split("/").filter(Boolean);
  const boardName = pathSegments[pathSegments.length - 1];
  const exportControl = document.getElementById("bwaAdminExport");
  const restoreControl = document.getElementById("bwaAdminRestore");
  const purgeControl = document.getElementById("bwaAdminPurge");
  const restoreFile = /** @type {HTMLInputElement | null} */ (
    document.getElementById("bwaAdminRestoreFile")
  );
  if (
    !backend ||
    !boardName ||
    !exportControl ||
    !restoreControl ||
    !purgeControl ||
    !restoreFile
  )
    return;
  const endpoint = adminDataEndpoint(backend, boardName);
  const headers = () => ({
    Authorization: `Bearer ${currentAdminToken() || ""}`,
  });

  activateWithKeyboard(exportControl, async () => {
    const response = await fetch(`${endpoint}/export`, {
      headers: headers(),
      credentials: "include",
    });
    if (!response.ok)
      return window.alert(t("admin_export_failed", "Export failed"));
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `bwa-${boardName}-backup.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  activateWithKeyboard(restoreControl, () => restoreFile.click());
  restoreFile.addEventListener("change", async () => {
    const file = restoreFile.files?.[0];
    if (
      !file ||
      !window.confirm(
        t(
          "admin_restore_confirmation",
          "Replace this board with the selected verified backup?",
        ),
      )
    )
      return;
    const response = await fetch(`${endpoint}/restore`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      credentials: "include",
      body: await file.text(),
    });
    if (!response.ok)
      return window.alert(t("admin_restore_failed", "Restore failed"));
    location.reload();
  });
  activateWithKeyboard(purgeControl, async () => {
    if (
      !window.confirm(
        t(
          "admin_purge_confirmation",
          "Permanently purge records deleted more than 30 days ago?",
        ),
      )
    )
      return;
    const response = await fetch(`${endpoint}/purge`, {
      method: "POST",
      headers: headers(),
      credentials: "include",
    });
    window.alert(
      response.ok
        ? t("admin_purge_succeeded", "Old records purged")
        : t("admin_purge_failed", "Purge failed"),
    );
  });
}

/** @import { AppToolsState } from "../../types/app-runtime" */

/**
 * Presentation-only BWA chrome. All tool, preference and viewport mutations are
 * delegated to the native WBO owners passed in by board_main.
 * @param {AppToolsState} tools
 */
export function installBwaChrome(tools) {
  const root = document.documentElement;
  const board = tools.dom.board;
  if (!board) return;
  const viewport = tools.viewportState.controller;
  const zoomValue = document.getElementById("bwaZoomValue");
  const zoomOut = document.getElementById("bwaZoomOut");
  const zoomIn = document.getElementById("bwaZoomIn");
  const focus = document.getElementById("bwaFocusToggle");
  const more = document.getElementById("bwaMoreToggle");
  const style = /** @type {HTMLDetailsElement | null} */ (
    document.getElementById("styleTool")
  );
  const styleClose = document.getElementById("bwaStyleClose");
  const styleSummary = document.getElementById("styleSummary");

  const syncZoom = () => {
    if (zoomValue)
      zoomValue.textContent = `${Math.round(viewport.getScale() * 100)}%`;
  };
  /** @param {number} factor */
  const zoomBy = (factor) => {
    viewport.zoomBy(factor, window.innerWidth / 2, window.innerHeight / 2);
    syncZoom();
  };

  zoomOut?.addEventListener("click", () => zoomBy(0.8));
  zoomIn?.addEventListener("click", () => zoomBy(1.25));
  board.addEventListener(VIEWPORT_LAYOUT_EVENT, syncZoom);
  window.addEventListener("scroll", syncZoom, { passive: true });

  focus?.addEventListener("click", () => {
    const active = root.dataset.bwaFocus === "true";
    root.dataset.bwaFocus = String(!active);
    focus.setAttribute("aria-pressed", String(!active));
  });

  const closeMoreMenu = () => {
    root.dataset.bwaMore = "false";
    more?.setAttribute("aria-expanded", "false");
  };
  /** @type {Map<number, number>} */
  const suppressedPointers = new Map();
  /** @type {Map<number, number>} */
  const suppressedTouches = new Map();
  /** @param {number} pointerId */
  const clearSuppressedPointer = (pointerId) => {
    const timer = suppressedPointers.get(pointerId);
    if (timer !== undefined) window.clearTimeout(timer);
    suppressedPointers.delete(pointerId);
  };
  /** @param {number} touchId */
  const clearSuppressedTouch = (touchId) => {
    const timer = suppressedTouches.get(touchId);
    if (timer !== undefined) window.clearTimeout(timer);
    suppressedTouches.delete(touchId);
  };
  /** @param {Event} event */
  const consumeDismissEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  /** @param {PointerEvent} event */
  const suppressPointer = (event) => {
    clearSuppressedPointer(event.pointerId);
    suppressedPointers.set(
      event.pointerId,
      window.setTimeout(() => clearSuppressedPointer(event.pointerId), 1_000),
    );
  };
  /** @param {number} touchId */
  const suppressTouch = (touchId) => {
    clearSuppressedTouch(touchId);
    suppressedTouches.set(
      touchId,
      window.setTimeout(() => clearSuppressedTouch(touchId), 1_000),
    );
  };

  more?.addEventListener("click", () => {
    const active = root.dataset.bwaMore === "true";
    root.dataset.bwaMore = String(!active);
    more.setAttribute("aria-expanded", String(!active));
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      const menu = more?.closest("#menu");
      const startsDismissal =
        root.dataset.bwaMore === "true" &&
        !(target instanceof Node && menu?.contains(target));
      const joinsDismissal =
        (suppressedPointers.size > 0 || suppressedTouches.size > 0) &&
        !(target instanceof Node && menu?.contains(target));
      if (!startsDismissal && !joinsDismissal) return;
      if (startsDismissal) closeMoreMenu();
      suppressPointer(event);
      consumeDismissEvent(event);
    },
    { capture: true },
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (!suppressedPointers.has(event.pointerId)) return;
      consumeDismissEvent(event);
      const pointerId = event.pointerId;
      window.setTimeout(() => clearSuppressedPointer(pointerId), 0);
    },
    { capture: true },
  );
  document.addEventListener(
    "pointercancel",
    (event) => {
      if (!suppressedPointers.has(event.pointerId)) return;
      consumeDismissEvent(event);
      clearSuppressedPointer(event.pointerId);
      if (suppressedPointers.size === 0) {
        for (const touchId of suppressedTouches.keys())
          clearSuppressedTouch(touchId);
      }
    },
    { capture: true },
  );
  document.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target;
      const menu = more?.closest("#menu");
      const startsDismissal =
        root.dataset.bwaMore === "true" &&
        !(target instanceof Node && menu?.contains(target));
      const joinsDismissal =
        (suppressedPointers.size > 0 || suppressedTouches.size > 0) &&
        !(target instanceof Node && menu?.contains(target));
      if (!startsDismissal && !joinsDismissal) return;
      if (startsDismissal) closeMoreMenu();
      for (const touch of event.changedTouches) suppressTouch(touch.identifier);
      consumeDismissEvent(event);
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    "touchend",
    (event) => {
      const matchingTouches = Array.from(event.changedTouches).filter((touch) =>
        suppressedTouches.has(touch.identifier),
      );
      if (matchingTouches.length === 0) return;
      consumeDismissEvent(event);
      for (const touch of matchingTouches)
        clearSuppressedTouch(touch.identifier);
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    "touchcancel",
    (event) => {
      const matchingTouches = Array.from(event.changedTouches).filter((touch) =>
        suppressedTouches.has(touch.identifier),
      );
      if (matchingTouches.length === 0) return;
      consumeDismissEvent(event);
      for (const touch of matchingTouches)
        clearSuppressedTouch(touch.identifier);
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    "click",
    (event) => {
      const pointerId =
        event instanceof PointerEvent && suppressedPointers.has(event.pointerId)
          ? event.pointerId
          : suppressedPointers.size === 1
            ? suppressedPointers.keys().next().value
            : undefined;
      if (pointerId === undefined) return;
      consumeDismissEvent(event);
      clearSuppressedPointer(pointerId);
    },
    { capture: true },
  );

  style?.addEventListener("toggle", () => {
    root.dataset.bwaStyleOpen = String(style.open);
  });
  styleClose?.addEventListener("click", () => {
    if (style) style.open = false;
    styleSummary?.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (style?.open) {
      style.open = false;
      styleSummary?.focus();
      event.preventDefault();
      return;
    }
    if (root.dataset.bwaMore === "true") {
      closeMoreMenu();
      more?.focus();
      event.preventDefault();
      return;
    }
    if (root.dataset.bwaFocus === "true") {
      root.dataset.bwaFocus = "false";
      focus?.setAttribute("aria-pressed", "false");
      focus?.focus();
      event.preventDefault();
    }
  });

  syncZoom();
  root.dataset.bwaChrome = "ready";
  installAdminDataControls();
}
