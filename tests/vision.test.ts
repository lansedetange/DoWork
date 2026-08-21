import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMedia, mediaMimeType } from "../src/main/vision.ts";

test("recognizes supported image and PDF types", () => {
  assert.equal(mediaMimeType("photo.JPG"), "image/jpeg");
  assert.equal(mediaMimeType("scan.pdf"), "application/pdf");
  assert.equal(mediaMimeType("archive.zip"), null);
});

test("sends inline media to Gemini without putting the key in the URL", async () => {
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  let requestedBody = "";
  const result = await analyzeMedia({
    name: "diagram.png",
    mimeType: "image/png",
    bytes: Buffer.from("fake-image"),
  }, "ocr", undefined, {
    env: {
      GEMINI_API_KEY: "test-placeholder-key",
      GEMINI_VISION_MODEL: "gemini-3.7-flash",
      GEMINI_DAILY_LIMIT: "10",
    },
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      requestedBody = String(init?.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "OCR result" }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result, "OCR result");
  assert.doesNotMatch(requestedUrl, /test-placeholder-key/);
  assert.equal(requestedHeaders?.get("x-goog-api-key"), "test-placeholder-key");
  assert.match(requestedBody, /inline_data/);
});
