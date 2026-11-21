import assert from "node:assert/strict";
import test from "node:test";

process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.OAUTH_SERVER_URL = "https://oauth.test";
process.env.OPENAI_BASE_URL = "https://analysis.test/v1";
process.env.OPENAI_API_KEY = "fixture";
process.env.OPENAI_MODEL = "fixture-model";

const { appRouter, translateClipCaptions } = await import("../dist/index.js");
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
  const result = await caller.gemini.detectHighlights({ ...input, autoStyle: false, videoDuration: 1197, transcriptWords: words });
  assert.equal(mainPass, true);
  assert.equal(windows, 2);
  assert.equal(result.highlights.length, 2);
  assert.ok(result.highlights.some(clip => clip.startTime > 600));
});

test("Auto gives each selected clip its own style and keeps an explicit Normal", async (t) => {
  const clips = [
    { ...candidate, title: "The punchline", startTime: 0, endTime: 20, kind: "joke", montage: "normal" },
    { ...candidate, title: "The quiet answer", startTime: 24, endTime: 44, kind: "insight", montage: "normal" },
    { ...candidate, title: "The quick screen switch", startTime: 48, endTime: 68, kind: "reveal", montage: "normal" },
  ];
  let reviews = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    if (!messages[0].content.startsWith("Choose the best editing style")) return modelReply({ highlights: clips });
    assert.match(messages[0].content, /\bJSON\b/);
    const reviewed = JSON.parse(messages[1].content);
    assert.deepEqual(reviewed.map(clip => clip.title), clips.map(clip => clip.title));
    reviews++;
    return modelReply({ styles: [
      { id: 1, style: "viral" }, { id: 2, style: "podcast" }, { id: 3, style: "normal" },
    ] });
  });
  const auto = await caller.gemini.detectHighlights({ ...input, videoDuration: 79 });
  assert.deepEqual(auto.highlights.map(clip => clip.montage), ["viral", "podcast", "normal"]);
  const manual = await caller.gemini.detectHighlights({ ...input, videoDuration: 79, autoStyle: false });
  assert.deepEqual(manual.highlights.map(clip => clip.montage), ["normal", "normal", "normal"]);
  assert.equal(reviews, 1);
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

test("caption translation keeps the original timing and leaves original captions intact", async (t) => {
  const captions = {
    words: [{ word: "واش", start: 0.2, end: 0.6 }, { word: "مزيان؟", start: 0.6, end: 1.1 },
      { word: "بزاف.", start: 2.1, end: 2.9 }],
    style: { captionLanguage: "fr" },
    synced: true,
  };
  const inference = t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    assert.match(messages[0].content, /French/);
    assert.equal(JSON.parse(messages[1].content).length, 2);
    return modelReply({ cues: [{ id: 1, text: "Beaucoup." }, { id: 0, text: "Ça va ?" }] });
  });
  assert.equal(await translateClipCaptions(captions, "fr"), captions);
  const translated = await translateClipCaptions(captions, "ar-ma");
  assert.equal(inference.mock.callCount(), 1);
  assert.equal(translated.synced, false);
  assert.equal(translated.words[0].start, 0.2);
  assert.equal(translated.words.at(-1).start, 2.1);
  assert.equal(translated.words.at(-1).end, 2.9);
  assert.equal(translated.words.map(word => word.word).join(" "), "Ça va ? Beaucoup.");
  assert.equal(captions.words[0].word, "واش");
});
