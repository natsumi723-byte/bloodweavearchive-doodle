/** @import { AppToolsState, BoardStatusView } from "../../types/app-runtime" */

function getBoardStatusElements() {
  return {
    indicator: document.getElementById("boardStatusIndicator"),
    title: document.getElementById("boardStatusTitle"),
    notice: document.getElementById("boardStatusNotice"),
    retry: document.getElementById("boardStatusRetry"),
  };
}

export class StatusModule {
  /**
   * @param {() => AppToolsState} getTools
   * @param {(level: "error" | "log" | "warn", event: string, fields?: {[key: string]: unknown}) => void} logBoardEvent
   */
  constructor(getTools, logBoardEvent) {
    this.getTools = getTools;
    this.logBoardEvent = logBoardEvent;
    this.rateLimitNoticeTimer = null;
    this.boardStatusTimer = null;
    this.explicitBoardStatus = null;
    this.initialLoading = true;
    this.boardWritable = false;
  }

  clearRateLimitNoticeTimer() {
    if (this.rateLimitNoticeTimer) {
      clearTimeout(this.rateLimitNoticeTimer);
      this.rateLimitNoticeTimer = null;
    }
  }

  clearBoardStatusTimer() {
    if (this.boardStatusTimer) {
      clearTimeout(this.boardStatusTimer);
      this.boardStatusTimer = null;
    }
  }

  /**
   * @param {string} message
   * @param {number} retryAfterMs
   */
  showRateLimitNotice(message, retryAfterMs) {
    const Tools = this.getTools();
    this.clearRateLimitNoticeTimer();
    this.showBoardStatus({
      hidden: false,
      state: "paused",
      title: Tools.i18n.t("slow_down_briefly"),
      detail: message,
    });
    if (retryAfterMs > 0) {
      this.rateLimitNoticeTimer = window.setTimeout(
        function hideRateLimitNotice() {
          Tools.status.hideRateLimitNotice();
        },
        retryAfterMs,
      );
    }
  }

  hideRateLimitNotice() {
    this.clearRateLimitNoticeTimer();
    this.clearBoardStatus();
  }

  showCapacityNotice() {
    const Tools = this.getTools();
    this.showBoardStatus({
      hidden: false,
      state: "paused",
      title: Tools.i18n.t("capacity_unavailable_title"),
      detail: Tools.i18n.t("capacity_unavailable_detail"),
      retryable: true,
    });
  }

  showCapacitySnapshotUnavailableNotice() {
    const Tools = this.getTools();
    this.showBoardStatus({
      hidden: false,
      state: "paused",
      title: Tools.i18n.t("capacity_snapshot_unavailable_title"),
      detail: Tools.i18n.t("capacity_snapshot_unavailable_detail"),
      retryable: true,
    });
  }

  /** @param {string} reason */
  showUnknownMutationError(reason) {
    const Tools = this.getTools();
    if (reason.length > 0) {
      this.logBoardEvent("warn", "mutation_rejected_unknown", {
        reason,
      });
    }
    this.showBoardStatus({
      hidden: false,
      state: "paused",
      title: Tools.i18n.t("unknown_error_reload_page"),
      detail: "",
    });
  }

  /**
   * @param {{reporterName?: string, reportedName?: string}} payload
   */
  showUserReportNotice(payload) {
    const Tools = this.getTools();
    const reporterName =
      typeof payload?.reporterName === "string" ? payload.reporterName : "";
    const reportedName =
      typeof payload?.reportedName === "string" ? payload.reportedName : "";
    if (!reporterName || !reportedName) return;

    this.showBoardStatus(
      {
        hidden: false,
        state: "paused",
        title: Tools.i18n.format("user_report_notice", {
          reporter: reporterName,
          reported: reportedName,
        }),
        detail: "",
      },
      6000,
    );
  }

  /**
   * @param {BoardStatusView} view
   * @param {number} [durationMs]
   */
  showBoardStatus(view, durationMs) {
    const Tools = this.getTools();
    this.clearBoardStatusTimer();
    this.explicitBoardStatus = view;
    this.syncWriteStatusIndicator();
    if (durationMs && durationMs > 0) {
      this.boardStatusTimer = window.setTimeout(() => {
        Tools.status.clearBoardStatus();
      }, durationMs);
    }
  }

  clearBoardStatus() {
    this.clearBoardStatusTimer();
    this.explicitBoardStatus = null;
    this.syncWriteStatusIndicator();
  }

  clearInitialLoading() {
    if (!this.initialLoading) return;
    this.initialLoading = false;
    this.syncWriteStatusIndicator();
  }

  /** @returns {BoardStatusView} */
  getBoardStatusView() {
    const Tools = this.getTools();
    if (this.explicitBoardStatus) {
      return this.explicitBoardStatus;
    }
    if (
      this.initialLoading ||
      Tools.connection.state !== "connected" ||
      Tools.replay.awaitingSnapshot
    ) {
      return {
        hidden: false,
        state: "reconnecting",
        title: Tools.i18n.t("loading"),
        detail: "",
      };
    }
    if (Tools.writes.localRateLimitedUntil > Date.now()) {
      return {
        hidden: false,
        state: "paused",
        title: Tools.i18n.t("slow_down_briefly"),
        detail: "",
      };
    }
    if (Tools.writes.bufferedWrites.some((w) => w.state === "queued")) {
      return {
        hidden: false,
        state: "buffering",
        title: Tools.i18n.t("loading"),
        detail: "",
      };
    }
    const current = Tools.toolRegistry.current;
    if (current && Tools.toolRegistry.shouldDisableTool(current.name)) {
      return {
        hidden: false,
        state: "paused",
        title: Tools.i18n.t("please_zoom_in_to_draw"),
        detail: "",
      };
    }
    return {
      hidden: true,
      state: "hidden",
      title: "",
      detail: "",
    };
  }

  syncWriteStatusIndicator() {
    const Tools = this.getTools();
    const writable = Tools.writes.canBufferWrites();
    if (writable !== this.boardWritable) {
      this.boardWritable = writable;
      // Readiness changes tool chrome even when the zoom is unchanged.
      Tools.toolRegistry.syncDrawToolAvailability(true);
    }
    if (writable && Tools.writes.writeReadyWaiters.length > 0) {
      const waiters = Tools.writes.writeReadyWaiters.splice(0);
      waiters.forEach((resolve) => resolve());
    }
    const { indicator, title, notice, retry } = getBoardStatusElements();
    if (!indicator || !title || !notice) return;

    const view = this.getBoardStatusView();
    indicator.classList.remove(
      "board-status-buffering",
      "board-status-paused",
      "board-status-reconnecting",
    );
    indicator.dataset.state = view.state;
    if (view.hidden) {
      indicator.hidden = true;
      return;
    }
    indicator.hidden = false;
    title.textContent = view.title;
    notice.textContent = view.detail;
    notice.classList.toggle("board-status-detail-hidden", !view.detail);
    indicator.classList.toggle(
      "board-status-retryable",
      view.retryable === true,
    );
    if (
      retry &&
      typeof HTMLButtonElement !== "undefined" &&
      retry instanceof HTMLButtonElement
    ) {
      retry.hidden = view.retryable !== true;
      retry.textContent = Tools.i18n.t("capacity_retry");
      retry.onclick =
        view.retryable === true ? () => Tools.connection.manualRetry() : null;
    }
    indicator.classList.add(`board-status-${view.state}`);
  }
}
