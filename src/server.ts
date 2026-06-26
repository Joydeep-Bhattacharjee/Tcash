import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RequestSchema } from "./schema.js";
import { analyzeTicket } from "./analyze.js";

// Agent Console (§5.3) — single self-contained HTML, served from the same app
// so one live URL gives judges/users a free, usable tool. Loaded once; if the
// file is missing the API still runs unaffected.
const __dirname = dirname(fileURLToPath(import.meta.url));
let CONSOLE_HTML = "";
let MANUAL_HTML = "";
try {
  CONSOLE_HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
  MANUAL_HTML = readFileSync(join(__dirname, "..", "public", "manual.html"), "utf8");
} catch {
  CONSOLE_HTML = "<h1>TCash SuperCop</h1><p>API is up. POST /analyze-ticket.</p>";
  MANUAL_HTML = "<h1>Manual</h1><p>Not found.</p>";
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 1_000_000, // 1MB — huge-complaint fuzz protection
});

// Clean handling of malformed JSON -> 400, no stack trace, no secret.
app.setErrorHandler((err, _req, reply) => {
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status === 400 || (err as { code?: string }).code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return reply.status(400).send({ error: "Bad Request", message: "Malformed request body." });
  }
  app.log.error(err);
  return reply.status(500).send({ error: "Internal Server Error", message: "An unexpected error occurred." });
});

// Agent Console at root (does not touch the scored API surface)
app.get("/", async (_req, reply) => {
  reply.type("text/html").send(CONSOLE_HTML);
});

// Manual route
app.get("/manual", async (_req, reply) => {
  reply.type("text/html").send(MANUAL_HTML);
});

// M1 — health gate
app.get("/health", async () => ({ status: "ok" }));

// M2/M3/M4/M5/M6 — the product
app.post("/analyze-ticket", async (req, reply) => {
  // Step 1 — validate
  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    // missing/invalid required fields -> 400
    return reply.status(400).send({
      error: "Bad Request",
      message: "Request failed schema validation.",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  // semantically empty -> 422
  const complaint = (parsed.data.complaint ?? "").trim();
  if (complaint.length === 0) {
    return reply.status(422).send({
      error: "Unprocessable Entity",
      message: "Complaint is empty; nothing to investigate.",
    });
  }

  try {
    const result = await analyzeTicket(parsed.data);
    return reply.status(200).send(result);
  } catch (e) {
    app.log.error(e);
    return reply.status(500).send({
      error: "Internal Server Error",
      message: "An unexpected error occurred while analyzing the ticket.",
    });
  }
});

app
  .listen({ port: PORT, host: HOST })
  .then((addr) => app.log.info(`TCash SuperCop listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
