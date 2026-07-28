/**
 * Credentials + config.json (SPEC §5): the env/file merge, the three-state
 * Settings edit, and the file mode.
 *
 * Runs against a throwaway config.json — `npm run test` points
 * IMAGE_CREATE_CONFIG at .test-data/, so the developer's real
 * ~/.image-create/config.json is never touched. That env var is the seam here,
 * the same way DATA_DIR is for the store tests.
 *
 * The keys below are obvious fakes; nothing here reaches a provider.
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import { afterEach, before, beforeEach, describe, test } from "node:test";

import { GET, POST } from "../app/api/settings/route";
import type { WireProviderSetting } from "@/lib/api/wire";
import {
  getProviderConfig,
  getProviderCredentials,
  hasCredentials,
  storedCredentials,
  updateStoredCredentials,
} from "@/lib/credentials";
import { CONFIG_FILE } from "@/lib/paths";

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "GOOGLE_API_KEY", "GOOGLE_BASE_URL", "GEMINI_BASE_URL"] as const;

before(() => {
  assert.ok(
    process.env.IMAGE_CREATE_CONFIG,
    "these tests must run with IMAGE_CREATE_CONFIG set — use `npm run test`",
  );
  assert.ok(
    !CONFIG_FILE.includes(".image-create"),
    "refusing to run against the real config file",
  );
});

beforeEach(() => {
  fs.rmSync(CONFIG_FILE, { force: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  fs.rmSync(CONFIG_FILE, { force: true });
});

function writeRaw(json: string): void {
  fs.mkdirSync(CONFIG_FILE.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, json);
}

describe("reading", () => {
  test("no file and no env means no credentials", () => {
    assert.deepEqual(getProviderConfig("openai"), {});
    assert.equal(hasCredentials("openai"), false);
    assert.deepEqual(storedCredentials(), {});
  });

  test("falls back to env, with the documented aliases", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    process.env.OPENAI_API_BASE = "https://env.example/v1"; // alias of OPENAI_BASE_URL
    process.env.GEMINI_BASE_URL = "https://gemini.example"; // alias of GOOGLE_BASE_URL

    assert.deepEqual(getProviderConfig("openai"), {
      apiKey: "sk-from-env",
      baseUrl: "https://env.example/v1",
    });
    assert.equal(getProviderConfig("google").baseUrl, "https://gemini.example");
    assert.equal(hasCredentials("google"), false, "a base URL alone is not usable");
  });

  test("the file overrides env field by field", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    process.env.OPENAI_BASE_URL = "https://env.example/v1";
    writeRaw(JSON.stringify({ providers: { openai: { apiKey: "sk-from-file" } } }));

    assert.deepEqual(getProviderConfig("openai"), {
      apiKey: "sk-from-file",
      baseUrl: "https://env.example/v1",
    });
  });

  test("accepts the bare legacy shape without a `providers` wrapper", () => {
    writeRaw(JSON.stringify({ google: { apiKey: "g-bare" } }));
    assert.equal(getProviderConfig("google").apiKey, "g-bare");
  });

  test("an unreadable or malformed file falls back to env instead of throwing", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    writeRaw("{ this is not json");
    assert.equal(getProviderConfig("openai").apiKey, "sk-from-env");
    assert.deepEqual(storedCredentials(), {});
  });

  test("blank values in env or file are treated as absent", () => {
    process.env.OPENAI_API_KEY = "   ";
    writeRaw(JSON.stringify({ providers: { google: { apiKey: "" } } }));
    assert.equal(hasCredentials("openai"), false);
    assert.equal(hasCredentials("google"), false);
  });

  test("storedCredentials reports the file only — that's what Settings may edit", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    writeRaw(JSON.stringify({ providers: { google: { apiKey: "g-in-file" } } }));

    assert.equal(getProviderCredentials().openai?.apiKey, "sk-from-env", "effective");
    assert.equal(storedCredentials().openai, undefined, "but not editable here");
    assert.equal(storedCredentials().google?.apiKey, "g-in-file");
  });
});

describe("updateStoredCredentials", () => {
  test("sets a trimmed value and creates the file 0600", () => {
    updateStoredCredentials({ openai: { apiKey: "  sk-typed  " } });

    assert.equal(storedCredentials().openai?.apiKey, "sk-typed");
    assert.equal(
      fs.statSync(CONFIG_FILE).mode & 0o777,
      0o600,
      "the file holds API keys — owner read/write only",
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")),
      { providers: { openai: { apiKey: "sk-typed" } } },
      "written in the canonical wrapped shape",
    );
  });

  test("stays 0600 when overwriting an existing file", () => {
    writeRaw(JSON.stringify({ providers: {} })); // created with default perms
    updateStoredCredentials({ openai: { apiKey: "sk-1" } });
    assert.equal(fs.statSync(CONFIG_FILE).mode & 0o777, 0o600);
  });

  test("a blank apiKey leaves the stored key alone", () => {
    updateStoredCredentials({ openai: { apiKey: "sk-keep" } });
    // What the form submits when the user edits only the base URL.
    updateStoredCredentials({ openai: { apiKey: "", baseUrl: "https://relay.example/v1" } });

    assert.deepEqual(storedCredentials().openai, {
      apiKey: "sk-keep",
      baseUrl: "https://relay.example/v1",
    });
  });

  test("null clears a key, and env takes over again", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    updateStoredCredentials({ openai: { apiKey: "sk-in-file" } });
    assert.equal(getProviderConfig("openai").apiKey, "sk-in-file");

    updateStoredCredentials({ openai: { apiKey: null } });
    assert.equal(storedCredentials().openai, undefined, "empty entry is dropped from the file");
    assert.equal(getProviderConfig("openai").apiKey, "sk-from-env", "env is visible again");
  });

  test("a blank baseUrl clears it, unlike a blank apiKey", () => {
    updateStoredCredentials({ openai: { apiKey: "sk-1", baseUrl: "https://relay.example" } });
    updateStoredCredentials({ openai: { baseUrl: "" } });

    assert.deepEqual(storedCredentials().openai, { apiKey: "sk-1" }, "key kept, URL gone");
  });

  test("an omitted field is left untouched", () => {
    updateStoredCredentials({ openai: { apiKey: "sk-1", baseUrl: "https://relay.example" } });
    updateStoredCredentials({ openai: {} });
    assert.deepEqual(storedCredentials().openai, {
      apiKey: "sk-1",
      baseUrl: "https://relay.example",
    });
  });

  test("only the named providers are touched", () => {
    updateStoredCredentials({ openai: { apiKey: "sk-1" }, google: { apiKey: "g-1" } });
    updateStoredCredentials({ google: { apiKey: null } });

    assert.equal(storedCredentials().openai?.apiKey, "sk-1");
    assert.equal(storedCredentials().google, undefined);
  });
});

/**
 * The route on top of it, because "a key never reaches a client" is a property
 * worth a test, not a comment. Handlers are plain functions over Request /
 * Response — no Next runtime needed.
 */
describe("GET/POST /api/settings", () => {
  async function get(): Promise<WireProviderSetting[]> {
    const body = (await (GET() as Response).json()) as { providers: WireProviderSetting[] };
    return body.providers;
  }

  const post = (body: unknown): Promise<Response> =>
    POST(new Request("http://localhost/api/settings", { method: "POST", body: JSON.stringify(body) }));

  test("reports a masked key and never the key itself", async () => {
    updateStoredCredentials({ openai: { apiKey: "sk-abcdef123456TAIL" } });

    const providers = await get();
    const openai = providers.find((p) => p.providerId === "openai");
    assert.ok(openai);
    assert.equal(openai.hasKey, true);
    assert.equal(openai.keyMasked, "····TAIL");
    assert.equal(
      JSON.stringify(providers).includes("sk-abcdef123456"),
      false,
      "the raw key is not in the response at all",
    );
  });

  test("distinguishes an env-provided key from an editable one", async () => {
    process.env.GOOGLE_API_KEY = "g-from-env";

    const [google] = (await get()).filter((p) => p.providerId === "google");
    assert.ok(google);
    assert.equal(google.hasKey, true, "usable");
    assert.equal(google.keyInFile, false, "but Settings can't clear a .env key");
  });

  test("a round-trip through the route stores what was submitted", async () => {
    assert.equal((await post({ openai: { apiKey: "sk-via-route", baseUrl: "https://relay.example" } })).status, 200);
    assert.deepEqual(storedCredentials().openai, {
      apiKey: "sk-via-route",
      baseUrl: "https://relay.example",
    });

    assert.equal((await post({ openai: { apiKey: null } })).status, 200);
    assert.equal(storedCredentials().openai?.apiKey, undefined);
    assert.equal(storedCredentials().openai?.baseUrl, "https://relay.example", "clearing the key kept the URL");
  });

  test("rejects a malformed body without touching the file", async () => {
    updateStoredCredentials({ openai: { apiKey: "sk-untouched" } });

    const res = await post({ openai: { apiKey: 42 } });
    assert.equal(res.status, 400);
    assert.equal(storedCredentials().openai?.apiKey, "sk-untouched");
  });
});
