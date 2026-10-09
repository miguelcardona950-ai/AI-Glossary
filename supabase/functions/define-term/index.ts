// Supabase Edge Function: writes a glossary definition for one term, using Claude.
//
// The Anthropic API key lives only in this function's secrets (ANTHROPIC_API_KEY),
// never in the app. Only a signed-in user can call it: the public anon key on its
// own is rejected, so nobody else can spend your API credit.
//
// Request:  POST { "term": "HEAD" }  with the signed-in user's token
// Response: 200 { "definition": "..." }  or an error status with { "error": "<code>" }:
//   400 invalid_term       the term is missing or longer than 200 characters
//   401 not_signed_in      no valid sign-in
//   402 ai_no_credit       the Anthropic account is out of credit
//   422 empty_definition   the answer was empty, cut off, declined or implausibly long
//   422 unknown_term       Claude didn't recognise the term as a software term
//   429 ai_busy            Anthropic rate limit
//   500 not_configured     ANTHROPIC_API_KEY is missing or rejected
//   502 ai_unavailable     Anthropic is down or unreachable
//   504 ai_timeout         Claude took too long

import Anthropic from "npm:@anthropic-ai/sdk@0.132.1";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// Pages allowed to call this function from a browser.
const ALLOWED_ORIGINS = [
  "https://miguelcardona950-ai.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
];

const MAX_TERM_LENGTH = 200;
const MAX_DEFINITION_LENGTH = 1200;
// Up to 12 s per attempt, with one automatic retry for brief hiccups, so the
// whole call stays under the app's 30-second limit.
const AI_TIMEOUT_MS = 12_000;
const AI_MAX_RETRIES = 1;
const UNKNOWN_MARKER = "UNKNOWN_TERM";

const SYSTEM_PROMPT = `You write entries for a personal glossary kept by someone who is learning to build software. They add a term when they run into it while coding and want to understand it quickly.

Write a definition of the term you're given:
- Two or three sentences in plain language. If you need another technical word, explain it.
- Be concrete: say what the thing is, then give an example of where they would actually run into it.
- If the term means different things in different areas of software (for example "origin" in git and in web security), define the meaning a beginner is most likely to meet and mention the other in a short clause.
- Wrap commands, code and file names in backticks, like \`git status\`. Use no other formatting: no headings, lists, bold, or quotation marks around the answer.
- Reply with the definition only, without an introduction such as "Here's a definition".

If the term isn't something from software or computing that you recognise, reply with exactly ${UNKNOWN_MARKER} and nothing else.`;

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  const reply = (status: number, body: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  // Only a real signed-in user gets through. The anon key is a valid token too,
  // but it belongs to no user, so getUser() rejects it.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await supabase.auth.getUser(token);
  if (authError || !auth.user) return reply(401, { error: "not_signed_in" });

  let term = "";
  try {
    const body = await req.json();
    term = typeof body?.term === "string" ? body.term.trim() : "";
  } catch {
    // Not JSON: handled as a missing term below.
  }
  if (!term || term.length > MAX_TERM_LENGTH) return reply(400, { error: "invalid_term" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set in this function's secrets");
    return reply(500, { error: "not_configured" });
  }
  const anthropic = new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES });

  try {
    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "low" }, // a short definition doesn't need deep reasoning
      // If Claude's safety filter declines (security terms occasionally trip it),
      // Anthropic re-runs the request on the model it recommends for that case.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Term: ${term}` }],
    });

    // Anything other than a finished answer (cut off, or declined by every
    // model in the fallback chain) counts as broken.
    if (response.stop_reason !== "end_turn") {
      console.error(`Unusable answer for "${term}": stop_reason=${response.stop_reason}`);
      return reply(422, { error: "empty_definition" });
    }
    const definition = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();

    if (definition === UNKNOWN_MARKER) return reply(422, { error: "unknown_term" });
    if (!definition || definition.length > MAX_DEFINITION_LENGTH) {
      console.error(`Unusable answer for "${term}": ${definition.length} characters`);
      return reply(422, { error: "empty_definition" });
    }
    return reply(200, { definition });
  } catch (error) {
    // Most specific first: the timeout and connection errors are subclasses of APIError.
    if (error instanceof Anthropic.APIConnectionTimeoutError) return reply(504, { error: "ai_timeout" });
    if (error instanceof Anthropic.APIConnectionError) return reply(502, { error: "ai_unavailable" });
    if (error instanceof Anthropic.RateLimitError) return reply(429, { error: "ai_busy" });
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      console.error("Anthropic rejected the API key:", error.message);
      return reply(500, { error: "not_configured" });
    }
    if (error instanceof Anthropic.APIError && error.status === 402) return reply(402, { error: "ai_no_credit" });
    if (error instanceof Anthropic.InternalServerError) return reply(502, { error: "ai_unavailable" });
    console.error("Unexpected error:", error);
    return reply(502, { error: "ai_unavailable" });
  }
});

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
