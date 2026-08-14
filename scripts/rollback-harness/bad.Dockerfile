# Convoy rollback harness — failure-injection image.
#
# Boots a Node HTTP server that answers every request (including /health)
# with HTTP 500. The machine stays UP (no crash loop), so the failure is
# visible to the Fly proxy and health checks — exactly the "deployed but
# broken" state a rollback must recover from.
#
# The image is self-contained (no COPY), so the build context can be any
# directory; scripts/rollback-harness.sh deploys it from this directory
# with the demo-app's fly.toml.
FROM node:20-alpine
EXPOSE 8080
CMD ["node", "-e", "require('http').createServer((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'err', mode: 'bad_release', note: 'injected failure — Convoy rollback harness' })); }).listen(8080, () => console.log('BAD_RELEASE_READY'))"]
