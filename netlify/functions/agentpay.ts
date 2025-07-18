import type { Context } from "@netlify/edge-functions"

/**
 * CONFIGURATION
 */
const TOLL_ID = "toll_ikaybhoeg7"


// Paths to protect
const PROTECTED_PATHS = [
  "/posts/example-post-1",
  "/"
]

/**
 * DO NOT TOUCH
 */

const AGENTPAY_BASE_URL = "https://agentpay.vercelapp.stripe.dev"
const PAY_URL = `${AGENTPAY_BASE_URL}/api/tolls/${TOLL_ID}/pay`

// List of well-known AI crawler User-Agents (grouped by provider)
const AI_BOT_USER_AGENTS = [
  // OpenAI
  "OAI-SearchBot",
  "ChatGPT-User",
  "ChatGPT-User/2.0",
  "GPTBot",
  // Anthropic
  "anthropic-ai",
  "ClaudeBot",
  "claude-web",
  "Claude-User",
  // Perplexity
  "PerplexityBot",
  "Perplexity-User",
  // Google
  "Google-Extended",
  // Microsoft / Bing
  "BingBot",
  // Amazon
  "Amazonbot",
  // Apple
  "Applebot",
  "Applebot-Extended",
  // Meta / Facebook
  "FacebookBot",
  "meta-externalagent",
  // Mistral
  'MistralAI-User',
  // LinkedIn
  "LinkedInBot",
  // ByteDance
  "Bytespider",
  // DuckDuckGo
  "DuckAssistBot",
  // Cohere
  "cohere-ai",
  // Allen Institute / Common Crawl / misc research
  "AI2Bot",
  "CCBot",
  "Diffbot",
  "omgili",
  // Emerging start-ups
  "TimpiBot",
  "YouBot",
  // Our test bot
  "StripeBot",
  "ChargeThisBot",
]

// Check if it's a protected path
const isProtectedPath = (pathname: string) => PROTECTED_PATHS.includes(pathname)

// Returns true if the provided UA string matches any known AI crawler above
const isAIUserAgent = (uaString = "") =>
  AI_BOT_USER_AGENTS.some((bot) => uaString.includes(bot))

const isAIBot = (headers: Headers) => {
  const ua = headers.get("user-agent") || ""

  const aiUserAgent = isAIUserAgent(ua)

  const aiSigHeadersPresent =
    headers.has("signature-agent") &&
    headers.has("signature-input") &&
    headers.has("signature")

  const agentPayPriceHeadersPresent =
    headers.has("crawler-price") ||
    headers.has("crawler-exact-price") ||
    headers.has("crawler-max-price")

  console.log(aiUserAgent, aiSigHeadersPresent, agentPayPriceHeadersPresent)

  return aiUserAgent || aiSigHeadersPresent || agentPayPriceHeadersPresent
}

export default async (request: Request, context: Context) => {
  console.log("In request!")
  const url = new URL(request.url)

  /* 1) Public / un-protected routes -> straight through */
  if (!isProtectedPath(url.pathname)) {
    console.log("Not protected path, going through")
    return context.next()
  }

  /* 2) Non-AI callers -> straight through */
  if (!isAIBot(request.headers)) {
    console.log("Not AI Bot, going through")
    return context.next()
  }

  /* 3) AI UA without HTTP-sig headers -> 402 immediately */
  const hasSigHeaders =
    request.headers.has("signature-agent") &&
    request.headers.has("signature-input") &&
    request.headers.has("signature")

  if (
    !hasSigHeaders
  ) {
    console.log("Blocked bot but no sig headers, 402")
    // Our middleware sends back a 402 if the crawler doesn't have the right headers
    return new Response(
      JSON.stringify({
        error: "Payment Required",
        message:
          "AI crawlers must pay to access this content. Register at the url provided in paymentUrl",
        paymentUrl: `${AGENTPAY_BASE_URL}/register`,
      }),
      {
        status: 402,
        headers: { "content-type": "application/json" },
      }
    )
  }

  /* 4) Build the AgentPay header set (parity with Node example) */
  const apHeaders = new Headers({ "Content-Type": "application/json" })

  request.headers.forEach((value, key) => {
    apHeaders.set(`X-Agentpay-${key}`, value)
  })

  apHeaders.set("X-Original-Url", request.url)

  /* 5) Ask AgentPay to charge / verify */
  let payResp
  try {
    payResp = await fetch(PAY_URL, { method: "POST", headers: apHeaders })
  } catch (err) {
    console.error("AgentPay error:", err)
    return new Response(
      JSON.stringify({
        error: "Payment Required",
        message:
          "Unable to verify payment. AI crawlers must pay to access this content. Register at the url in paymentUrl",
        paymentUrl: `${AGENTPAY_BASE_URL}/register`,
      }),
      { status: 402, headers: { "content-type": "application/json" } }
    )
  }

  /* 6) Handle AgentPay response -------------------------------------- */
  if (payResp.ok) {
    console.log("Agentpay response is good")
    console.log(payResp)
    const resp = await context.next()

    // Mirror useful headers back to caller
    const charged = payResp.headers.get("x-agentpay-crawler-charged")
    if (charged) {
      resp.headers.set("crawler-charged", charged)
    }

    return resp
  }

  // 402 from AgentPay
  const headers: any = {};
  payResp.headers.forEach((value, key) => {
    const headerKey = key.startsWith("x-agentpay-") ? key.slice(11) : key;
    headers[headerKey] = value;
  });

  console.log("Payment required from crawler")

  return new Response(
    JSON.stringify({
      error: "Payment Required",
      message:
        "Invalid payment authentication. Set the crawler crawler-exact-price or crawler-max-price header to access this content",
      paymentUrl: `${AGENTPAY_BASE_URL}/register`,
      price: headers["x-agentpay-crawler-price"],
    }),
    { status: 402, headers: headers },
  );
};

