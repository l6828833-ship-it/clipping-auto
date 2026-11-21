import assert from "node:assert/strict";
import test from "node:test";

process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.OAUTH_SERVER_URL = "https://oauth.test";
process.env.OPENAI_BASE_URL = "https://analysis.test/v1";
process.env.OPENAI_API_KEY = "fixture";
process.env.OPENAI_MODEL = "fixture-model";

const { appRouter } = await import("../dist/index.js");
const caller = appRouter.createCaller({ user: { id: 1 } });
const input = {
  transcript: "A short, complete story with an opening and a payoff.",
  videoDuration: 12,
  apiKey: "server",
};

const modelReply = content => Response.json({
  model: "fixture-model",
  choices: [{ message: { content: JSON.stringify(content) } }],
});
const candidate = {
  id: 1, title: "A complete story", startTime: 1, endTime: 10, engagementScore: 95, evidence: "speech",
};

test("the production highlight handler returns its selected clips", async (t) => {
  const inference = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://analysis.test/v1/chat/completions");
    return modelReply({ reelTitle: "Fixture story", highlights: [candidate] });
  });
  const result = await caller.gemini.detectHighlights(input);
  assert.equal(result.analysisMode, "speech");
  assert.equal(result.highlights.length, 1);
  assert.equal(result.highlights[0].title, "A complete story");
  assert.equal(inference.mock.callCount(), 1);
});

test("empty first pass is retried and the returned clips can be used", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => ++requests === 1
    ? modelReply({ highlights: [] })
    : modelReply([{ ...candidate, startTime: "1", endTime: "10" }]));
  const result = await caller.gemini.detectHighlights(input);
  assert.equal(requests, 2);
  assert.equal(result.highlights[0].title, "A complete story");
});

test("a video just under 20 minutes keeps valid window results after a malformed main pass", async (t) => {
  const words = Array.from({ length: 1800 }, (_, index) => ({
    word: index % 12 === 11 ? "story." : "word",
    start: index * 0.65,
    end: index * 0.65 + 0.4,
  }));
  let windows = 0;
  let mainPass = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const prompt = messages.at(-1).content;
    if (prompt.startsWith("This is one part of a longer video")) {
      const startTime = windows++ === 0 ? 12 : 610;
      return modelReply({ highlights: [{ ...candidate, startTime, endTime: startTime + 22 }] });
    }
    if (prompt.includes("ALREADY CHOSEN")) return modelReply({ highlights: [] });
    mainPass = true;
    return modelReply({ highlights: "unexpected shape" });
  });
  const result = await caller.gemini.detectHighlights({ ...input, videoDuration: 1197, transcriptWords: words });
  assert.equal(mainPass, true);
  assert.equal(windows, 2);
  assert.equal(result.highlights.length, 2);
  assert.ok(result.highlights.some(clip => clip.startTime > 600));
});

test("rejects invalid timestamps and offers manual timing if recovery finds nothing", async (t) => {
  const inference = t.mock.method(globalThis, "fetch", async () => modelReply({
    highlights: [{ ...candidate, startTime: false }, { ...candidate, startTime: "" }, { ...candidate, startTime: null }],
  }));
  await assert.rejects(() => caller.gemini.detectHighlights(input), {
    code: "PRECONDITION_FAILED",
    message: /choose clip times manually/,
  });
  assert.equal(inference.mock.callCount(), 2);
});

test("missing speech and frames returns guidance without calling the model", async (t) => {
  const inference = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected inference"));
  await assert.rejects(() => caller.gemini.detectHighlights({ ...input, transcript: "" }), {
    code: "PRECONDITION_FAILED",
    message: /Upload a video excerpt/,
  });
  assert.equal(inference.mock.callCount(), 0);
});

test("unexpected model failures return a generic client message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Unrelated upstream text", { status: 503 }));
  t.mock.method(console, "error", () => {});
  await assert.rejects(() => caller.gemini.detectHighlights(input), {
    code: "INTERNAL_SERVER_ERROR",
    message: "AI analysis couldn’t finish. Try again.",
  });
});
