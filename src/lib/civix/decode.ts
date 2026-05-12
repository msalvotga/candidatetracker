export function decodeBase64Json<T>(b64: string): T {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const text = new TextDecoder("utf-8").decode(bytes);
  return JSON.parse(text) as T;
}

export function decodeUploadPayload<T>(body: unknown): T {
  if (body && typeof body === "object" && "upload" in body && typeof (body as { upload: unknown }).upload === "string") {
    return decodeBase64Json<T>((body as { upload: string }).upload);
  }
  throw new Error("Expected Civix JSON wrapper with an `upload` base64 string");
}
