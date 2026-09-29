import { createApp, MCP_PATH } from "./app.js";

const PORT = Number(process.env.PORT) || 8000;

createApp().listen(PORT, "0.0.0.0", () => {
  console.log(`[gcal-hosted] listening on 0.0.0.0:${PORT}${MCP_PATH}`);
});
