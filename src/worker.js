/**
 * Atlas de Bolso — backend (Cloudflare Worker)
 *
 * Serve os arquivos do site (pasta /public) e três rotas de API:
 *   GET  /api/ping    → confere o código de acesso e se a chave da API está configurada (não gasta tokens)
 *   GET  /api/fx      → cotação do dólar do dia (ExchangeRate-API, acesso aberto)
 *   POST /api/claude  → repassa um pedido ao Claude, em streaming
 *
 * Segredos (Cloudflare → Settings → Variables and Secrets, tipo "Secret"):
 *   ANTHROPIC_API_KEY  chave da API da Anthropic (sk-ant-...)
 *   ACCESS_CODE        código que o app pede para liberar o uso
 *
 * Variáveis opcionais (wrangler.jsonc → "vars"):
 *   MODEL_MAIN  modelo dos roteiros e trechos   (padrão: claude-sonnet-5-5)
 *   MODEL_FAST  modelo das tarefas leves        (padrão: claude-haiku-5-5)
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_PROMPT_CHARS = 14000;

/* Cada tarefa tem modelo e teto de tokens definidos AQUI, no servidor.
   O navegador só escolhe a tarefa — nunca o modelo nem o tamanho da resposta.
   O teto (maxTokens) é só um limite de segurança: a cobrança é pelo que o modelo realmente escreve. */
const TASKS = {
  city:     { tier: "main", maxTokens: 9000 },               // roteiro de uma cidade
  transfer: { tier: "main", maxTokens: 5000 },               // opções entre cidades
  home:     { tier: "main", maxTokens: 3500 },               // volta para casa
  guide:    { tier: "fast", maxTokens: 7000, search: 3 },    // guia do país (com busca na web)
  near:     { tier: "fast", maxTokens: 2500 },               // comida, fotos e descanso por perto
  suggest:  { tier: "fast", maxTokens: 3000 },               // sugerir atrações
  locate:   { tier: "fast", maxTokens: 1500 },               // localizar um lugar digitado
  pick:     { tier: "fast", maxTokens: 1200 },               // "me surpreenda" sem destino
  lodging:  { tier: "fast", maxTokens: 6000, images: 4 },    // aba Hospedagem: lê prints/texto de resultados
};

/* Os modelos 5.5 "pensam" antes de responder (por padrão em esforço alto), e esse raciocínio
   consome o limite de tokens. Para respostas estruturadas como as nossas, esforço baixo basta:
   fica mais rápido e mais barato. No Sonnet 5.5 o raciocínio antecipado pode ser desligado
   com thinking: between_tools. Se um modelo recusar esses campos, o pedido é refeito sem eles. */
function thinkingConfig(model) {
  const cfg = { output_config: { effort: "low" } };
  if (/sonnet-5-5/.test(model)) cfg.thinking = { type: "between_tools" };
  return cfg;
}

const SYSTEM =
  "Você é o motor de um app de planejamento de viagens. Responda SOMENTE com o JSON pedido, " +
  "sem texto antes ou depois e sem blocos de código markdown. Use dados reais; quando não tiver " +
  "certeza de um telefone, endereço ou site, use null em vez de inventar.";

const SYSTEM_SEARCH =
  SYSTEM +
  " Use a busca na web para confirmar telefones de emergência, embaixadas e consulados. " +
  "Depois das buscas, a sua mensagem final deve conter apenas o JSON.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: "server_error", message: String(err && err.message || err) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === "/api/fx" && request.method === "GET") return fx();

  // Tudo abaixo exige o código de acesso.
  const auth = checkAccess(request, env);
  if (auth) return auth;

  if (path === "/api/ping" && request.method === "GET") {
    return json({ ok: true, apiKey: Boolean(env.ANTHROPIC_API_KEY) });
  }
  if (path === "/api/claude" && request.method === "POST") return claude(request, env);

  return json({ error: "not_found" }, 404);
}

function checkAccess(request, env) {
  if (!env.ACCESS_CODE) return json({ error: "not_configured", message: "ACCESS_CODE não configurado na Cloudflare." }, 503);
  const given = request.headers.get("x-access-code") || "";
  if (!safeEqual(given, String(env.ACCESS_CODE))) return json({ error: "unauthorized" }, 401);
  return null;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function claude(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "not_configured", message: "ANTHROPIC_API_KEY não configurada na Cloudflare." }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request", message: "JSON inválido." }, 400); }

  const task = TASKS[body && body.task];
  const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
  if (!task) return json({ error: "bad_request", message: "Tarefa desconhecida." }, 400);
  if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS) return json({ error: "bad_request", message: "Pedido vazio ou grande demais." }, 400);

  // Prints de tela (só nas tarefas que aceitam imagens): JPEG/PNG/WebP em base64, até 4, ~1,5 MB cada.
  let images = [];
  if (Array.isArray(body.images) && body.images.length) {
    if (!task.images) return json({ error: "bad_request", message: "Esta tarefa não aceita imagens." }, 400);
    images = body.images.slice(0, task.images).filter(im => im && /^image\/(jpeg|png|webp)$/.test(im.type) && typeof im.data === "string" && im.data.length < 2200000);
    if (!images.length) return json({ error: "bad_request", message: "Imagens inválidas." }, 400);
  }

  const model = task.tier === "main"
    ? (env.MODEL_MAIN || "claude-sonnet-5-5")
    : (env.MODEL_FAST || "claude-haiku-5-5");

  const payload = {
    model,
    max_tokens: task.maxTokens,
    stream: true,
    system: task.search ? SYSTEM_SEARCH : SYSTEM,
    messages: [{ role: "user", content: images.length
      ? [...images.map(im => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })), { type: "text", text: prompt }]
      : prompt }],
  };
  if (task.search) payload.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: task.search }];

  const send = body => fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  let upstream = await send({ ...payload, ...thinkingConfig(model) });
  let detail = "";
  if (upstream.status === 400) {
    try { const e = await upstream.json(); detail = e && e.error && e.error.message || ""; } catch {}
    // Modelo não aceitou a configuração de raciocínio: tenta de novo com os padrões dele.
    if (/thinking|effort|output_config|between_tools/i.test(detail)) { upstream = await send(payload); detail = ""; }
  }

  if (!upstream.ok) {
    if (!detail) { try { const e = await upstream.json(); detail = e && e.error && e.error.message || ""; } catch {} }
    const code = upstream.status === 401 ? "bad_api_key"
      : upstream.status === 429 || upstream.status === 529 ? "rate_limited"
      : upstream.status === 400 && /credit|billing|balance/i.test(detail) ? "no_credit"
      : "upstream_error";
    return json({ error: code, message: detail }, upstream.status === 401 ? 502 : upstream.status);
  }

  // Repassa o stream da Anthropic sem processar — quase zero CPU no Worker.
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-model": model,
    },
  });
}

async function fx() {
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { cf: { cacheTtl: 21600, cacheEverything: true } });
    if (!r.ok) throw new Error("fx " + r.status);
    const d = await r.json();
    if (!d || d.result !== "success" || !d.rates) throw new Error("fx payload");
    const asOf = d.time_last_update_unix ? new Date(d.time_last_update_unix * 1000).toISOString().slice(0, 10) : null;
    return json({ asOf, source: "ExchangeRate-API", per: d.rates }, 200, { "cache-control": "public, max-age=21600" });
  } catch (err) {
    return json({ error: "fx_unavailable" }, 502);
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
