// @ts-nocheck
const listenersSymbol = Symbol("listeners");
const ERASER_TOOL_CODE = 6;
const CLEAR_TOOL_CODE = 11;
let activeAdminToken = null;
let adminLockInstalled = false;
let adminWindowBlurred = false;
let adminWindowReloading = false;

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

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function boardToken(boardName) {
  const key = `bwa:v2:owner:${boardName}`;
  let token = localStorage.getItem(key);
  if (!token) {
    token = randomToken();
    localStorage.setItem(key, token);
  }
  return token;
}

export function isAdminPath(pathname) {
  const segments = String(pathname || "")
    .split("/")
    .filter(Boolean);
  return segments.length >= 2 && segments.at(-2) === "admin";
}

function adminToken() {
  if (!isAdminPath(location.pathname)) return null;
  try {
    sessionStorage.removeItem("bwa:v2:admin");
  } catch {}
  if (activeAdminToken) return activeAdminToken;
  if (typeof document === "undefined" || !document.body?.appendChild) {
    activeAdminToken =
      window.prompt(t("admin_secret_prompt", "Enter administrator key")) || "";
    return activeAdminToken || null;
  }
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "wbo-modal-backdrop";
    backdrop.id = "bwaAdminUnlock";

    const form = document.createElement("form");
    form.className = "wbo-dialog";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    form.setAttribute("aria-labelledby", "bwaAdminUnlockTitle");

    const title = document.createElement("div");
    title.className = "wbo-dialog-title";
    title.id = "bwaAdminUnlockTitle";
    title.textContent = t("admin_unlock_title", "Administrator access");

    const message = document.createElement("label");
    message.className = "wbo-dialog-message";
    message.htmlFor = "bwaAdminSecret";
    message.textContent = t("admin_secret_prompt", "Enter administrator key");

    const input = document.createElement("input");
    input.id = "bwaAdminSecret";
    input.type = "password";
    input.autocomplete = "current-password";
    input.required = true;

    const actions = document.createElement("div");
    actions.className = "wbo-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "wbo-dialog-button wbo-dialog-button-secondary";
    cancel.textContent = t("cancel", "Cancel");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "wbo-dialog-button wbo-dialog-button-primary";
    submit.textContent = t("admin_unlock_submit", "Unlock");

    const settle = (value) => {
      backdrop.remove();
      activeAdminToken = value || null;
      resolve(activeAdminToken);
    };
    cancel.addEventListener("click", () => settle(null));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      settle(input.value.trim());
    });
    actions.append(cancel, submit);
    form.append(title, message, input, actions);
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    input.focus();
  });
}

export function currentAdminToken() {
  return activeAdminToken;
}

export function buildPublicBoardUrl(boardName, currentUrl) {
  const source = new URL(currentUrl);
  const publicUrl = new URL(
    `../boards/${encodeURIComponent(boardName)}`,
    source,
  );
  publicUrl.search = source.search;
  publicUrl.hash = source.hash;
  return publicUrl.href;
}

function leaveCancelledAdminEntry(boardName) {
  const publicUrl = buildPublicBoardUrl(boardName, window.location.href);
  window.location.replace(publicUrl);
}

export function installAdminAutoLock(lockConnection, runtime = {}) {
  const windowObject = runtime.windowObject || window;
  const documentObject = runtime.documentObject || document;
  const locationObject = runtime.locationObject || location;
  if (adminLockInstalled || !isAdminPath(locationObject.pathname)) return;
  adminLockInstalled = true;
  const lockAdminWindow = () => {
    if (adminWindowBlurred) return;
    adminWindowBlurred = true;
    activeAdminToken = null;
    lockConnection();
  };
  const reloadLockedWindow = () => {
    if (!adminWindowBlurred || adminWindowReloading) return;
    adminWindowReloading = true;
    locationObject.reload();
  };
  windowObject.addEventListener("pagehide", lockAdminWindow);
  documentObject.addEventListener("visibilitychange", () => {
    if (documentObject.visibilityState === "hidden") lockAdminWindow();
    if (documentObject.visibilityState === "visible") reloadLockedWindow();
  });
}

export class CloudflareSocket {
  constructor(baseUrl, boardName) {
    this.baseUrl = baseUrl;
    this.boardName = boardName;
    this.connected = false;
    this.id = `cf-${crypto.randomUUID()}`;
    this[listenersSymbol] = new Map();
    this.pending = new Map();
    this.inflight = new Map();
    this.flushTimers = new Map();
    this.sequence = 0;
    this.lastDeleteMutation = null;
    this.ws = null;
  }

  on(name, callback) {
    const callbacks = this[listenersSymbol].get(name) || [];
    callbacks.push(callback);
    this[listenersSymbol].set(name, callbacks);
    return this;
  }

  dispatch(name, payload) {
    for (const callback of this[listenersSymbol].get(name) || [])
      callback(payload);
  }

  connect() {
    const requiresAdmin = isAdminPath(location.pathname);
    const elevated = adminToken();
    if (elevated instanceof Promise) {
      elevated.then((token) => this.openConnection(requiresAdmin, token));
      return;
    }
    this.openConnection(requiresAdmin, elevated);
  }

  openConnection(requiresAdmin, elevated) {
    const routePrefix = requiresAdmin ? "/api/admin/boards" : "/api/boards";
    const socketBaseUrl = requiresAdmin
      ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`
      : this.baseUrl;
    const url = `${socketBaseUrl}${routePrefix}/${encodeURIComponent(this.boardName)}/socket`;
    const protocols = ["bwa-v2", `owner.${boardToken(this.boardName)}`];
    protocols.push(`socket.${this.id}`);
    if (requiresAdmin && !elevated) {
      leaveCancelledAdminEntry(this.boardName);
      return;
    }
    if (elevated) protocols.push(`admin.${elevated}`);
    this.ws = new WebSocket(url, protocols);
    if (elevated) {
      installAdminAutoLock(() => this.ws?.close(1000, "admin window locked"));
    }
    this.ws.addEventListener("open", () => {
      this.connected = true;
      this.dispatch("connect");
      this.dispatch("boardstate", {
        canEdit: true,
        canWrite: true,
        canClear: requiresAdmin && Boolean(elevated),
        canBan: false,
        canReport: false,
      });
    });
    this.ws.addEventListener("message", (event) =>
      this.receive(JSON.parse(event.data)),
    );
    this.ws.addEventListener("close", () => {
      this.connected = false;
      if (this.inflight.size > 0 || this.pending.size > 0) {
        this.dispatch("mutation_retry");
      }
      this.dispatch("disconnect", "transport close");
    });
    this.ws.addEventListener("error", () =>
      this.dispatch("connect_error", new Error("cloudflare_websocket_error")),
    );
  }

  disconnect() {
    this.ws?.close(1000, "client disconnect");
  }

  emit(name, message) {
    if (name !== "broadcast" || !message) return;
    const type = Number(message.type);
    if (type === 6) {
      if (!isAdminPath(location.pathname) || !activeAdminToken) {
        this.dispatch("mutation_rejected", { reason: "admin_required" });
        return;
      }
      const mutationId = this.createMutationId();
      this.sendDurableMutation(
        { type: "admin.delete_all", mutationId, sender: this.id },
        [message.clientMutationId].filter(Boolean),
      );
      return;
    }
    if (type === 3 && message.id) {
      this.flushItem(message.id);
      this.lastDeleteMutation = message;
      const mutationId = this.stableMutationId([message]);
      this.sendDurableMutation(
        {
          type: "stroke.delete",
          mutationId,
          id: message.id,
          sender: this.id,
        },
        [message.clientMutationId].filter(Boolean),
      );
      return;
    }
    const itemId = String(message.parent || message.id || "");
    if (!itemId) return;
    const batch = this.pending.get(itemId) || [];
    batch.push(message);
    this.pending.set(itemId, batch);
    clearTimeout(this.flushTimers.get(itemId));
    this.flushTimers.set(
      itemId,
      setTimeout(() => this.flushItem(itemId), 120),
    );
  }

  flushItem(itemId) {
    clearTimeout(this.flushTimers.get(itemId));
    this.flushTimers.delete(itemId);
    const mutations = this.pending.get(itemId);
    if (!mutations?.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.pending.delete(itemId);
    const mutationId = this.stableMutationId(mutations);
    this.sendDurableMutation(
      {
        type: "stroke.commit",
        mutationId,
        id: itemId,
        sender: this.id,
        payload: { mutations },
      },
      mutations.map((mutation) => mutation.clientMutationId).filter(Boolean),
    );
  }

  createMutationId() {
    return `mutation_${crypto.randomUUID().replaceAll("-", "")}`;
  }

  stableMutationId(mutations) {
    const existing = mutations.find(
      (mutation) => mutation.cloudflareMutationId,
    )?.cloudflareMutationId;
    const mutationId = existing || this.createMutationId();
    for (const mutation of mutations)
      mutation.cloudflareMutationId = mutationId;
    return mutationId;
  }

  sendDurableMutation(frame, clientMutationIds) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.dispatch("mutation_retry");
      return false;
    }
    this.inflight.set(frame.mutationId, { frame, clientMutationIds });
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  receive(message) {
    if (message.type === "presence.joined" && message.user) {
      this.dispatch("user_joined", message.user);
      return;
    }
    if (message.type === "presence.left" && message.socketId) {
      this.dispatch("user_left", { socketId: message.socketId });
      return;
    }
    if (message.type === "snapshot") {
      const mutations = message.items.flatMap(
        (item) => item.payload?.mutations || [],
      );
      this.dispatch("broadcast", {
        fromSeq: 0,
        seq: mutations.length,
        _children: mutations,
      });
      this.sequence = mutations.length;
      return;
    }
    if (message.type === "mutation.ack") {
      const operation = this.inflight.get(message.mutationId);
      if (!operation) return;
      this.inflight.delete(message.mutationId);
      this.dispatch("mutation_accepted", {
        mutationId: message.mutationId,
        clientMutationIds: operation.clientMutationIds,
        sequence: message.sequence,
        duplicate: message.duplicate === true,
      });
      return;
    }
    if (message.type === "stroke.commit") {
      for (const mutation of message.payload?.mutations || []) {
        this.sequence += 1;
        this.dispatch("broadcast", {
          seq: this.sequence,
          mutation: { ...mutation, socket: message.sender },
        });
      }
      return;
    }
    if (message.type === "stroke.delete") {
      this.sequence += 1;
      this.dispatch("broadcast", {
        seq: this.sequence,
        mutation: {
          tool: ERASER_TOOL_CODE,
          type: 3,
          id: message.id,
          socket: message.sender,
        },
      });
      return;
    }
    if (message.type === "admin.delete_all") {
      this.sequence = Math.max(
        this.sequence + 1,
        Number(message.sequence) || 0,
      );
      this.dispatch("broadcast", {
        seq: this.sequence,
        mutation: {
          tool: CLEAR_TOOL_CODE,
          type: 6,
          id: "",
          socket: message.sender,
        },
      });
      return;
    }
    if (message.type === "board.recovered") {
      const admin = isAdminPath(location.pathname) && Boolean(activeAdminToken);
      this.dispatch("boardstate", {
        canEdit: true,
        canWrite: true,
        canClear: admin,
        canBan: false,
        canReport: false,
      });
      return;
    }
    if (message.type === "error") {
      const operation = message.mutationId
        ? this.inflight.get(message.mutationId)
        : null;
      if (message.mutationId) this.inflight.delete(message.mutationId);
      const rejected = this.lastDeleteMutation;
      this.lastDeleteMutation = null;
      if (
        message.code === "read_only_degraded" ||
        message.code === "storage_failure" ||
        message.code === "board_full"
      ) {
        this.dispatch("boardstate", {
          canEdit: false,
          canWrite: false,
          canClear: false,
          canBan: false,
          canReport: false,
        });
      }
      this.dispatch("mutation_rejected", {
        reason: message.code,
        ...(operation?.clientMutationIds
          ? { clientMutationIds: operation.clientMutationIds }
          : {}),
        ...(rejected?.clientMutationId
          ? { clientMutationId: rejected.clientMutationId }
          : {}),
      });
    }
  }
}

export function createCloudflareIo() {
  if (
    typeof document === "undefined" ||
    typeof document.querySelector !== "function"
  )
    return null;
  const baseUrl = document.querySelector(
    'meta[name="bwa-cloudflare-backend"]',
  )?.content;
  if (!baseUrl) return null;
  return {
    providesCompleteSnapshots: true,
    connect(_namespace, params) {
      const query = new URLSearchParams(params?.query || "");
      return new CloudflareSocket(
        baseUrl.replace(/\/$/, ""),
        query.get("board") || "anonymous",
      );
    },
  };
}
