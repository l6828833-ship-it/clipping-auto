/**
 * Hook to read/write the Inworld API key from localStorage.
 * The model is fixed to Claude Sonnet 5 and never changes.
 */
import { useState } from "react";

const KEY_STORAGE = "shortspro_inworld_key";
export const FIXED_MODEL = "openai/gpt-4.1";

export function useInworldKey() {
  const [apiKey, setApiKeyState] = useState<string>(() => {
    try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; }
  });

  const setApiKey = (key: string) => {
    setApiKeyState(key);
    try { localStorage.setItem(KEY_STORAGE, key); } catch { /* ignore */ }
  };

  return {
    apiKey,
    setApiKey,
    /** Always Claude Sonnet 5. */
    model: FIXED_MODEL,
    hasKey: apiKey.trim().length > 0,
  };
}
