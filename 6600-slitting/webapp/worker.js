"use strict";

importScripts("vendor/highs.js");
importScripts("vendor/highs-wasm-base64.js");

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let highsPromise = null;
function getHighs() {
  if (!highsPromise) {
    const wasmBinary = base64ToUint8Array(globalThis.HIGHS_WASM_BASE64);
    highsPromise = Module({ wasmBinary });
  }
  return highsPromise;
}

self.onmessage = async (e) => {
  const { id, lp, options } = e.data;
  try {
    const highs = await getHighs();
    const sol = highs.solve(lp, options);
    self.postMessage({ id, ok: true, sol });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
