import { describe, expect, it } from "vitest";
import {
  albumPreview,
  encodeAlbum,
  MAX_ALBUM_IMAGES,
  parseAlbum,
  decryptFile,
  detectImageMime,
  encodeImage,
  encryptFile,
  fitSize,
  parseImage,
  type ImageRef,
} from "../image";

const REF: ImageRef = {
  id: "0b6f3c1e-2a4d-4f5e-9a8b-7c6d5e4f3a2b",
  key: "a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=",
  mime: "image/jpeg",
  w: 1280,
  h: 960,
  size: 123456,
};

function bytes(...head: number[]): Uint8Array {
  const out = new Uint8Array(32);
  out.set(head);
  return out;
}

const ascii = (str: string) => Array.from(str, (c) => c.charCodeAt(0));

describe("image message format", () => {
  it("round-trips through the payload", () => {
    expect(parseImage(encodeImage(REF))).toEqual(REF);
  });

  it("rejects text, stickers and malformed payloads", () => {
    expect(parseImage("привет")).toBeNull();
    expect(parseImage("STK1:noto/1f600")).toBeNull();
    expect(parseImage("IMG1:{not json")).toBeNull();
    expect(parseImage(encodeImage({ ...REF, id: "../../etc/passwd" }))).toBeNull();
    expect(parseImage(encodeImage({ ...REF, mime: "image/svg+xml" as never }))).toBeNull();
    expect(parseImage(encodeImage({ ...REF, w: 0 }))).toBeNull();
  });
});

describe("detectImageMime", () => {
  it("recognises allowed image formats", () => {
    expect(detectImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(detectImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(detectImageMime(bytes(...ascii("GIF89a")))).toBe("image/gif");
    expect(detectImageMime(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")))).toBe("image/webp");
  });

  it("refuses video and everything else", () => {
    // MP4 / MOV: «....ftyp»
    expect(detectImageMime(bytes(0, 0, 0, 0x18, ...ascii("ftypmp42")))).toBeNull();
    // WebM / MKV
    expect(detectImageMime(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBeNull();
    expect(detectImageMime(bytes(...ascii("<svg xmlns=")))).toBeNull();
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("file encryption", () => {
  it("decrypts with the right key only", () => {
    const data = new Uint8Array(5000).map((_, i) => i % 251);
    const { blob, key } = encryptFile(data);
    expect(blob.length).toBe(data.length + 40);
    expect(decryptFile(blob, key)).toEqual(data);

    const other = encryptFile(data).key;
    expect(decryptFile(blob, other)).toBeNull();
  });

  it("detects tampering", () => {
    const { blob, key } = encryptFile(new Uint8Array(100));
    blob[60] ^= 1;
    expect(decryptFile(blob, key)).toBeNull();
    expect(decryptFile(new Uint8Array(10), key)).toBeNull();
  });
});

describe("fitSize", () => {
  it("shrinks into the box keeping proportions, never enlarges", () => {
    expect(fitSize(4000, 3000, 320, 360)).toEqual({ width: 320, height: 240 });
    expect(fitSize(1000, 4000, 320, 360)).toEqual({ width: 90, height: 360 });
    expect(fitSize(100, 50, 320, 360)).toEqual({ width: 100, height: 50 });
  });
});

describe("album message format", () => {
  const second: ImageRef = { ...REF, id: "1b6f3c1e-2a4d-4f5e-9a8b-7c6d5e4f3a2b", mime: "image/png" };

  it("keeps a lone picture without caption in the old format older apps understand", () => {
    expect(encodeAlbum([REF])).toBe(encodeImage(REF));
    expect(parseAlbum(encodeImage(REF))).toEqual({ images: [REF], text: "" });
  });

  it("carries several pictures and a caption in one message", () => {
    const payload = encodeAlbum([REF, second], "Смотри, @bob");
    expect(payload.startsWith("IMG2:")).toBe(true);
    expect(parseImage(payload)).toBeNull();
    expect(parseAlbum(payload)).toEqual({ images: [REF, second], text: "Смотри, @bob" });
    // Одна картинка с подписью — тоже альбом.
    expect(parseAlbum(encodeAlbum([REF], "подпись"))).toEqual({ images: [REF], text: "подпись" });
  });

  it("rejects empty, oversized and tampered albums", () => {
    expect(parseAlbum("IMG2:" + JSON.stringify({ images: [], text: "x" }))).toBeNull();
    const seven = Array.from({ length: MAX_ALBUM_IMAGES + 1 }, () => REF);
    expect(parseAlbum("IMG2:" + JSON.stringify({ images: seven, text: "" }))).toBeNull();
    expect(parseAlbum("IMG2:" + JSON.stringify({ images: [REF, { ...REF, id: "../x" }], text: "" }))).toBeNull();
    expect(parseAlbum("IMG2:{broken")).toBeNull();
    expect(parseAlbum("привет")).toBeNull();
  });

  it("previews as photos with the caption", () => {
    expect(albumPreview({ images: [REF], text: "" })).toBe("📷 Фото");
    expect(albumPreview({ images: [REF, second, REF], text: "  Отпуск " })).toBe("📷 3 фото · Отпуск");
  });
});
