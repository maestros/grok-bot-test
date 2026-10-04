import { ResearchError } from "../errors.js";

export function createGrok({ apiKey, model, baseUrl, fetchImpl = fetch }) {
  return {
    configured: Boolean(apiKey),
    async complete(system, user) {
      if (!apiKey) {
        throw new ResearchError(
          "not_configured",
          "XAI_API_KEY is not set. Add it to the server environment and try again.",
        );
      }
      const input = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      try {
        const data = await postJson(
          `${baseUrl}/responses`,
          apiKey,
          { model, store: false, input },
          fetchImpl,
        );
        return parseModelJson(responseText(data));
      } catch (error) {
        if (![400, 404, 405].includes(error.status)) throw describe(error);
        try {
          const data = await postJson(
            `${baseUrl}/chat/completions`,
            apiKey,
            { model, temperature: 0, messages: input },
            fetchImpl,
          );
          return parseModelJson(responseText(data));
        } catch (fallbackError) {
          throw describe(fallbackError);
        }
      }
    },
  };
}

export function responseText(data) {
  if (!data || typeof data !== "object") throw new Error("Empty model response");
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (typeof content?.text === "string" && content.type !== "reasoning") parts.push(content.text);
    }
  }
  if (parts.length) return parts.join("\n");
  const choice = data.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice.trim()) return choice;
  throw new Error("Empty model response");
}

export function parseModelJson(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model did not return JSON");
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function postJson(url, apiKey, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    const error = new Error("xAI could not be reached");
    error.status = 0;
    throw error;
  }
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(`xAI request failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function describe(error) {
  if (error instanceof ResearchError) return error;
  if (error.status === 401 || error.status === 403) {
    return new ResearchError("model_failed", "The xAI API rejected XAI_API_KEY.");
  }
  return new ResearchError("model_failed", "The research model request failed. Try again in a moment.");
}
