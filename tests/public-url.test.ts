import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttpsUrl, isPrivateAddress } from "../src/main/public-url.ts";

test("blocks local and private network targets", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.10"), true);
  assert.equal(isPrivateAddress("198.18.0.115"), false);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  await assert.rejects(assertPublicHttpsUrl("http://example.com"), /HTTPS/);
  await assert.rejects(assertPublicHttpsUrl("https://localhost/admin"), /内网/);
  await assert.rejects(
    assertPublicHttpsUrl("https://example.test", async () => [{ address: "10.0.0.4", family: 4 }]),
    /内网地址/,
  );
});

test("accepts public HTTPS targets after DNS validation", async () => {
  const url = await assertPublicHttpsUrl(
    "https://example.com/article",
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  assert.equal(url.toString(), "https://example.com/article");
});
