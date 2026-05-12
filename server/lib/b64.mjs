import { Buffer } from "node:buffer";

export function decodeBase64Json(b64) {
  const buf = Buffer.from(b64, "base64");
  return JSON.parse(buf.toString("utf8"));
}

export function decodeUploadPayload(body) {
  if (body && typeof body === "object" && typeof body.upload === "string") {
    return decodeBase64Json(body.upload);
  }
  throw new Error("Expected JSON body with base64 `upload` field");
}

export function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
