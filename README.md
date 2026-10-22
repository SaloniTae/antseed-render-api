# AntSeed GLM API on Render

This is an authenticated wrapper around the AntSeed CLI buyer. It **does not host model weights**; requests are routed to independent providers on the AntSeed peer-to-peer network.

## Current test result (22 October 2026)

The wrapper's end-to-end tests passed on a GitHub-hosted Linux runner for Chat Completions, streaming, Anthropic Messages, OpenAI Responses, concurrent small requests, token authentication, and the private-route denylist. Those protocol tests used a catalog-listed zero-price `glm-4.7-flash` seller.

**GLM 5.3 Flash itself did not pass the strict zero-price availability test in the current catalog snapshot.** The catalog exposed an `e2ee-glm-5-3-flash` offer priced above zero, with a reputation score below the buyer's default minimum trust score. With hard input/output caps of $0 per million tokens, the request correctly failed closed with `502 model_not_found`, instead of being routed to a paid seller. Earlier runs have been able to obtain GLM responses, so availability can change; do not infer current availability from the model's presence in the catalog.

The zero-price protocol-test run recorded buyer activity with `amountUsdc: "0"`, `spentUsdcBaseUnits: "0"`, and no active payment channels. A provider's response field `usage.cost` may represent an upstream inference estimate, not a buyer settlement.

## Deploy with Render Blueprint

1. In Render, choose **New + → Blueprint**.
2. Connect this repository: `SaloniTae/antseed-render-api`.
3. Review the service and deploy it. `render.yaml` defines `npm install`, `npm start`, a health check, and a generated `API_TOKEN`.
4. Copy `API_TOKEN` from Render's Environment page. Keep it secret.

Node.js 20 or later is required. Render's public service listens on `PORT` (normally 10000); AntSeed's buyer listens on loopback port 8377. The wrapper does not expose AntSeed's `/_antseed/` control plane.

**Not yet verified:** this repository has not been deployed and tested on a live Render service. GitHub Actions smoke tests are not proof that Render's build, startup, wake-up, and runtime limits will behave identically.

## API

Base URL: `https://YOUR-SERVICE.onrender.com/v1`

List text models:

```bash
curl 'https://YOUR-SERVICE.onrender.com/v1/models?type=text' \
  -H 'Authorization: Bearer YOUR_API_TOKEN'
```

Chat completion:

```bash
curl -X POST 'https://YOUR-SERVICE.onrender.com/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_API_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"model":"e85d7445bd5b0e29f6308fe8d42b5efdeea38f07@glm-4.7-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

The wrapper accepts either `Authorization: Bearer YOUR_API_TOKEN` or native Anthropic `x-api-key: YOUR_API_TOKEN`. The text API routes include OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, token counting, and the text-model catalog. The wrapper also passes Chat Completions streaming through. Image/video routes are deliberately not exposed because they have different billing behavior.

Health check (no token required): `https://YOUR-SERVICE.onrender.com/healthz`.

## Free-only routing

The buyer is configured to prefer free peers and applies hard $0 caps for input and output token pricing. The CLI also receives runtime-only zero-price flags. This means requests should fail if no seller meets the $0 policy; it does **not** guarantee that every listed model has a free, trusted, online seller, and it does not guarantee unlimited availability.

AntSeed documents that `preferFreePeers` is a ranking preference, while `maxPricing` is the hard limit. The buyer's default minimum trust score is 60. A catalog entry does not itself guarantee that a policy-eligible provider is available.

## Security and operational limitations

- All exposed API routes require a shared API token; the public health check is unauthenticated. Bearer and Anthropic `x-api-key` styles are supported.
- This wrapper has one shared token. It has **no per-user keys, budgets, rate limits, request log, or per-caller usage accounting**. Consider the AntSeed Gateway for individual API keys, spend budgets, model policies, and usage logs.
- Anyone with `API_TOKEN` can use the service. Rotate the token immediately if it leaks.
- The local buyer itself does not enforce API-key authentication. Never expose port 8377 publicly.
- Providers are independent peers; model availability, latency, output quality, and compatible request parameters can vary.
- The October 22 npm audit found **19 vulnerability entries (13 moderate, 6 high, 0 critical)** in the dependency tree. This service should not be considered production-security-clean until the advisories are reviewed and resolved. Do not blindly run `npm audit fix --force`; it may downgrade or break AntSeed's dependency tree.
- Render Free services sleep after 15 minutes without inbound traffic and may take about a minute to wake. Their filesystem is ephemeral, and local buyer identity/state/activity data can be lost on sleep, restart or redeployment. This setup is best for a disposable zero-price demo, not durable paid-wallet custody or guaranteed always-on production service.
- The API suite ran on a hosted Linux runner, not live Render. No persistent wallet or funded-wallet/settlement test was performed.

## Recommended production direction

If you need per-client keys, spend limits, model policies, and logs, use AntSeed's Gateway rather than only the local buyer. Use persistent hosting/storage for long-lived gateway identity, wallet state and logs. Keep zero-price caps if paid fallback is unacceptable; otherwise set non-zero caps only after explicitly deciding the maximum amount you're willing to spend.

## References

- AntSeed local buyer API: https://antseed.com/docs/guides/using-the-api/
- AntSeed buyer config and hard caps: https://antseed.com/docs/buyer-config/
- AntSeed Gateway and API keys: https://antseed.com/docs/gateway/
- AntSeed Gateway budgets: https://antseed.com/docs/gateway/budgets/
- Render Free service limitations: https://render.com/docs/free
