# AntSeed GLM API on Render

This is a small, authenticated OpenAI/Anthropic-compatible wrapper around the AntSeed CLI buyer. It does **not** host GLM weights itself; requests are routed to independent providers on the AntSeed peer-to-peer network.

## Deploy with Render Blueprint

1. In Render, choose **New + → Blueprint**.
2. Connect this repository: `SaloniTae/antseed-render-api`.
3. Review the service and deploy it. `render.yaml` defines `npm install`, `npm start`, a health check, and a generated `API_TOKEN`.
4. Copy the generated `API_TOKEN` from Render's Environment page. Keep it secret.

Use Node.js 20 or later. Render's public service listens on `PORT` (normally 10000); the AntSeed buyer stays on local port 8377. The wrapper does not expose AntSeed's `/_antseed/` control plane.

## API

Base URL: `https://YOUR-SERVICE.onrender.com/v1`

List available models:

```bash
curl 'https://YOUR-SERVICE.onrender.com/v1/models?type=text' \
  -H 'Authorization: Bearer YOUR_API_TOKEN'
```

Chat completion:

```bash
curl -X POST 'https://YOUR-SERVICE.onrender.com/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_API_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5-3-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

The wrapper also permits OpenAI Responses (`POST /v1/responses`) and Anthropic Messages (`POST /v1/messages`) formats, including Chat Completions streaming. It exposes the text-model catalog and token-count endpoint. Image and video endpoints are intentionally not exposed because their pricing is not governed by the same token-price caps.

Unauthenticated health check: `https://YOUR-SERVICE.onrender.com/healthz`.

## Free-only routing

The buyer sets `preferFreePeers=true` and applies hard price caps of $0 per million input and output tokens via buyer configuration and startup flags. This was tested successfully against GLM 5.3 Flash on a hosted runner. That test returned a response and AntSeed's buyer activity reported zero USDC spend; the response's upstream `usage.cost` field can still contain a provider-reported inference estimate, which is not the same as an AntSeed payment settlement.

Zero-price caps mean the request should fail when no eligible zero-price provider can serve it. They do **not** guarantee that a provider is always online, the same provider is selected each time, or the model is unlimited.

## Security and operational limitations

- Every exposed API route requires `Authorization: Bearer YOUR_API_TOKEN`; `/healthz` is public for health checks.
- The wrapper exposes only text-model endpoints. AntSeed's private control-plane and separate image/video billing endpoints return 404.
- Anyone who obtains `API_TOKEN` can use the allowed text API. Rotate the token immediately if it leaks.
- The local buyer itself has no API-key check; the wrapper's authentication is therefore important. Do not expose port 8377 publicly.
- AntSeed's model catalog and providers are dynamic; availability, output quality, latency and price depend on which independent peers are online.
- The service was tested on a GitHub-hosted Linux runner, not yet in a live Render deployment. Render's free web instances sleep after 15 minutes of inactivity and take about a minute to wake; local filesystem changes are lost when the instance spins down, restarts or redeploys.
- The CLI creates a wallet identity/state under its data directory. Render's ephemeral filesystem means identity and local activity history can change after restarts. This design is intended for zero-price public text models, not as durable custody for funded buyer wallets.
- The test suite checks startup, auth rejection, catalog discovery, Chat Completions, streaming, Anthropic Messages, OpenAI Responses, control-plane/media route denial, concurrent small requests and buyer activity. Provider/network behavior can change independently after the test runs.

## Useful checks

```bash
# Health (no key required)
curl https://YOUR-SERVICE.onrender.com/healthz

# Text models (key required)
curl 'https://YOUR-SERVICE.onrender.com/v1/models?type=text' \
  -H 'Authorization: Bearer YOUR_API_TOKEN'
```

AntSeed references:
- CLI installation: https://antseed.com/docs/install/
- Local buyer API/endpoints/errors: https://antseed.com/docs/api/
- Buyer routing and hard caps: https://antseed.com/docs/buyer-config/
- CLI flags: https://antseed.com/docs/flags/
- CLI commands, activity and metering: https://antseed.com/docs/commands/
