# AntSeed GLM API on Render

This service runs the AntSeed CLI buyer on localhost and exposes an authenticated OpenAI-compatible API through Render.

## Deploy with Render Blueprint

1. In Render, choose **New + → Blueprint**.
2. Select this repository: `SaloniTae/antseed-render-api`.
3. Review the service and deploy it. The `render.yaml` file supplies the build/start commands and asks Render to generate `API_TOKEN`.
4. After deployment, copy the generated `API_TOKEN` from Render's Environment page. Do not publish it.

AntSeed requires Node.js 20 or later. The buyer listens privately on `127.0.0.1:8377`; only the authenticated wrapper is public.

## API

Base URL: `https://YOUR-SERVICE.onrender.com/v1`

List models:

```bash
curl https://YOUR-SERVICE.onrender.com/v1/models \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Chat completion (replace the model with an exact ID from `/v1/models`):

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5-3-flash","messages":[{"role":"user","content":"Say hello"}]}'
```

Health check: `https://YOUR-SERVICE.onrender.com/healthz`

## Free-price routing

The buyer is configured to prefer free sellers and to use hard input/output caps of $0 per million tokens. If no provider can serve a request within those caps, it should fail rather than intentionally route to a positive-price seller. This does not guarantee that a free provider will always be available or that its service is unlimited.

## Notes

- Keep `API_TOKEN` private. Anyone who has it can use your hosted proxy.
- The Render Free instance may sleep after inactivity, so the first request can be slow.
- Render's filesystem is ephemeral; buyer identity/state may reset after restarts or redeployments.
- This is a proxy to AntSeed's provider network, not a model hosted directly on Render.
- AntSeed CLI docs: https://antseed.com/docs/install/
- Local buyer API docs: https://antseed.com/docs/guides/using-the-api/
- Buyer configuration docs: https://antseed.com/docs/buyer-config/
