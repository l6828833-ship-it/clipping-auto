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

test("the production highlight handler returns its selected clips", async (t) => {
  const inference = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://analysis.test/v1/chat/completions");
    return Response.json({
      model: "fixture-model",
      choices: [{ message: { content: JSON.stringify({
        reelTitle: "Fixture story",
        highlights: [{
          id: 1, title: "A complete story", startTime: 1, endTime: 10, engagementScore: 95, evidence: "speech",
        }],
      }) } }],
    });
  });
  const result = await caller.gemini.detectHighlights(input);
  assert.equal(result.analysisMode, "speech");
  assert.equal(result.highlights.length, 1);
  assert.equal(result.highlights[0].title, "A complete story");
  assert.equal(inference.mock.callCount(), 1);
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
