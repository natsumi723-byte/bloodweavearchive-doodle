const BOARD_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ITEM_PATTERN = /^[A-Za-z0-9_-]{8,96}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MUTATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function normalizeBoardId(value) {
  const boardId = String(value || "").toLowerCase();
  return BOARD_PATTERN.test(boardId) ? boardId : null;
}

export function parseClientMessage(value) {
  let message;
  try {
    message = JSON.parse(String(value));
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, code: "invalid_message" };
  }
  const mutationId = String(message.mutationId || "");
  if (message.type === "stroke.batch") {
    if (!MUTATION_PATTERN.test(mutationId)) {
      return { ok: false, code: "invalid_mutation_id" };
    }
    if (
      !Array.isArray(message.operations) ||
      message.operations.length === 0 ||
      message.operations.length > 1024
    ) {
      return { ok: false, code: "invalid_batch" };
    }
    const encoded = JSON.stringify(message.operations);
    if (new TextEncoder().encode(encoded).byteLength > 262144)
      return { ok: false, code: "payload_too_large" };
    const operations = [];
    for (const operation of message.operations) {
      if (!operation || typeof operation !== "object")
        return { ok: false, code: "invalid_batch_operation" };
      const id = String(operation.id || "");
      if (!ITEM_PATTERN.test(id))
        return { ok: false, code: "invalid_item_id" };
      if (operation.type === "stroke.delete") {
        operations.push({ type: operation.type, id });
        continue;
      }
      if (
        operation.type !== "stroke.commit" ||
        !operation.payload ||
        typeof operation.payload !== "object" ||
        Array.isArray(operation.payload)
      ) {
        return { ok: false, code: "invalid_batch_operation" };
      }
      operations.push({ type: operation.type, id, payload: operation.payload });
    }
    const sender = ITEM_PATTERN.test(String(message.sender || ""))
      ? message.sender
      : null;
    return {
      ok: true,
      message: {
        type: message.type,
        mutationId,
        operations,
        sender,
      },
    };
  }
  if (message.type === "stroke.commit") {
    if (!MUTATION_PATTERN.test(mutationId)) {
      return { ok: false, code: "invalid_mutation_id" };
    }
    if (!ITEM_PATTERN.test(String(message.id || ""))) {
      return { ok: false, code: "invalid_item_id" };
    }
    const payload = message.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, code: "invalid_payload" };
    }
    const encoded = JSON.stringify(payload);
    if (encoded.length > 262144) return { ok: false, code: "payload_too_large" };
    const sender = ITEM_PATTERN.test(String(message.sender || "")) ? message.sender : null;
    return { ok: true, message: { type: message.type, mutationId, id: message.id, payload, sender } };
  }
  if (message.type === "stroke.delete") {
    if (!MUTATION_PATTERN.test(mutationId)) {
      return { ok: false, code: "invalid_mutation_id" };
    }
    if (!ITEM_PATTERN.test(String(message.id || ""))) {
      return { ok: false, code: "invalid_item_id" };
    }
    const sender = ITEM_PATTERN.test(String(message.sender || "")) ? message.sender : null;
    return { ok: true, message: { type: message.type, mutationId, id: message.id, sender } };
  }
  if (message.type === "admin.delete_all") {
    if (!MUTATION_PATTERN.test(mutationId)) {
      return { ok: false, code: "invalid_mutation_id" };
    }
    return { ok: true, message: { type: message.type, mutationId } };
  }
  if (message.type === "cursor") {
    const x = Number(message.x);
    const y = Number(message.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, code: "invalid_cursor" };
    }
    return { ok: true, message: { type: message.type, x, y } };
  }
  return { ok: false, code: "unknown_type" };
}

export function validOwnerToken(value) {
  return TOKEN_PATTERN.test(String(value || ""));
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
