const assert = require("node:assert/strict");
const test = require("node:test");

test("Cloudflare admin capability is exposed only on the dedicated admin path", async () => {
  const { buildPublicBoardUrl, isAdminPath } = await import(
    "../client-data/js/cloudflare_socket_adapter.js"
  );

  assert.equal(isAdminPath("/admin/bwa-cloudflare-v2b"), true);
  assert.equal(isAdminPath("/prefix/admin/bwa-cloudflare-v2b"), true);
  assert.equal(isAdminPath("/boards/bwa-cloudflare-v2b"), false);
  assert.equal(isAdminPath("/boards/bwa-cloudflare-v2b?admin=1"), false);
  assert.equal(isAdminPath("/admin"), false);
  assert.equal(
    buildPublicBoardUrl(
      "bwa-cloudflare-v2b",
      "http://127.0.0.1:5043/admin/bwa-cloudflare-v2b?lang=zh-CN#1,2,3",
    ),
    "http://127.0.0.1:5043/boards/bwa-cloudflare-v2b?lang=zh-CN#1,2,3",
  );
});

test("administrator connection locks while hidden and reloads when visible", async () => {
  const { installAdminAutoLock } = await import(
    "../client-data/js/cloudflare_socket_adapter.js"
  );
  const windowListeners = new Map();
  const documentListeners = new Map();
  let locks = 0;
  let reloads = 0;
  const documentObject = {
    visibilityState: "visible",
    /** @param {string} name @param {Function} callback */
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    },
  };
  const windowObject = {
    /** @param {string} name @param {Function} callback */
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    },
  };
  const locationObject = {
    pathname: "/admin/bwa-cloudflare-v2b",
    reload() {
      reloads += 1;
    },
  };

  installAdminAutoLock(
    () => {
      locks += 1;
    },
    { windowObject, documentObject, locationObject },
  );

  documentObject.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  assert.equal(locks, 1);

  documentObject.visibilityState = "visible";
  documentListeners.get("visibilitychange")();
  assert.equal(reloads, 1);

  documentListeners.get("visibilitychange")();
  assert.equal(reloads, 1, "reload is issued only once while returning");
});
