import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import "dotenv/config";

// ─── Config ──────────────────────────────────────────────────────────────────

const GHOST_URL = process.env.GHOST_URL ?? "";
const GHOST_ADMIN_KEY = process.env.GHOST_ADMIN_KEY ?? ""; // format: id:secret
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

function assertConfig() {
  if (!GHOST_URL) throw new Error("GHOST_URL is required in environment");
  if (!GHOST_ADMIN_KEY || !GHOST_ADMIN_KEY.includes(":"))
    throw new Error(
      "GHOST_ADMIN_KEY must be set in format 'id:secret' (Staff Access Token from Ghost Admin → Integrations)"
    );
  // OPENAI_API_KEY is optional at boot — generate_post_image will throw at call time if absent
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY || "unset" });

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Ghost Admin API uses HS256 JWT signed with the hex-decoded secret part of
// the Staff Access Token (format: `{id}:{secret}`).

function makeAdminJwt(): string {
  const [id, secret] = GHOST_ADMIN_KEY.split(":");
  const key = Buffer.from(secret, "hex");

  return jwt.sign(
    { aud: "/admin/" },
    key,
    {
      keyid: id,
      algorithm: "HS256",
      expiresIn: "5m",
    }
  );
}

function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Ghost ${makeAdminJwt()}`,
    "Content-Type": "application/json",
    "Accept-Version": "v5.0",
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const base = () => `${GHOST_URL.replace(/\/$/, "")}/ghost/api/admin`;

async function ghostFetch(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = `${base()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...adminHeaders(), ...(options.headers as Record<string, string> ?? {}) },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ghost API ${res.status}: ${body}`);
  }

  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "ghost",
  version: "1.0.0",
});

// ── Posts ──────────────────────────────────────────────────────────────────────

server.tool(
  "list_posts",
  "List Ghost blog posts",
  {
    limit: z.number().optional().default(15).describe("Max posts to return"),
    status: z
      .enum(["published", "draft", "scheduled", "all"])
      .optional()
      .default("all")
      .describe("Filter by status"),
    page: z.number().optional().default(1).describe("Page number"),
  },
  async ({ limit, status, page }) => {
    const params = new URLSearchParams({
      limit: String(limit),
      page: String(page),
      fields: "id,title,status,published_at,url,slug",
    });
    if (status !== "all") params.set("filter", `status:${status}`);

    const data = (await ghostFetch(`/posts/?${params}`)) as {
      posts: unknown[];
      meta: unknown;
    };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "get_post",
  "Get a Ghost post by ID or slug",
  {
    id: z.string().optional().describe("Post ID"),
    slug: z.string().optional().describe("Post slug"),
  },
  async ({ id, slug }) => {
    if (!id && !slug) throw new Error("Provide either id or slug");
    const path = id ? `/posts/${id}/` : `/posts/slug/${slug}/`;
    const data = await ghostFetch(path);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "create_post",
  "Create a new Ghost post",
  {
    title: z.string().describe("Post title"),
    html: z.string().optional().describe("Post body as HTML"),
    status: z
      .enum(["draft", "published", "scheduled"])
      .optional()
      .default("draft"),
    tags: z.array(z.string()).optional().describe("Tag names to attach"),
    published_at: z
      .string()
      .optional()
      .describe("ISO 8601 datetime — required when status is 'scheduled'"),
  },
  async ({ title, html, status, tags, published_at }) => {
    const post: Record<string, unknown> = { title, status };
    if (html) post.html = html;
    if (tags) post.tags = tags.map((name) => ({ name }));
    if (published_at) post.published_at = published_at;

    const data = await ghostFetch("/posts/", {
      method: "POST",
      body: JSON.stringify({ posts: [post] }),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "update_post",
  "Update an existing Ghost post",
  {
    id: z.string().describe("Post ID to update"),
    updated_at: z
      .string()
      .describe(
        "Current updated_at value from the post (required by Ghost for optimistic concurrency)"
      ),
    title: z.string().optional(),
    html: z.string().optional(),
    status: z.enum(["draft", "published", "scheduled"]).optional(),
    tags: z.array(z.string()).optional(),
    published_at: z.string().optional(),
  },
  async ({ id, updated_at, title, html, status, tags, published_at }) => {
    const post: Record<string, unknown> = { updated_at };
    if (title) post.title = title;
    if (html) post.html = html;
    if (status) post.status = status;
    if (tags) post.tags = tags.map((name) => ({ name }));
    if (published_at) post.published_at = published_at;

    const data = await ghostFetch(`/posts/${id}/`, {
      method: "PUT",
      body: JSON.stringify({ posts: [post] }),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "delete_post",
  "Delete a Ghost post by ID",
  {
    id: z.string().describe("Post ID to delete"),
  },
  async ({ id }) => {
    await ghostFetch(`/posts/${id}/`, { method: "DELETE" });
    return {
      content: [{ type: "text", text: `Post ${id} deleted.` }],
    };
  }
);

// ── Pages ──────────────────────────────────────────────────────────────────────

server.tool(
  "list_pages",
  "List Ghost static pages",
  {
    limit: z.number().optional().default(15),
    status: z
      .enum(["published", "draft", "all"])
      .optional()
      .default("all"),
  },
  async ({ limit, status }) => {
    const params = new URLSearchParams({
      limit: String(limit),
      fields: "id,title,status,url,slug",
    });
    if (status !== "all") params.set("filter", `status:${status}`);

    const data = await ghostFetch(`/pages/?${params}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool(
  "create_page",
  "Create a new Ghost static page",
  {
    title: z.string(),
    html: z.string().optional(),
    status: z.enum(["draft", "published"]).optional().default("draft"),
  },
  async ({ title, html, status }) => {
    const page: Record<string, unknown> = { title, status };
    if (html) page.html = html;

    const data = await ghostFetch("/pages/", {
      method: "POST",
      body: JSON.stringify({ pages: [page] }),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ── Members ────────────────────────────────────────────────────────────────────

server.tool(
  "list_members",
  "List Ghost members/subscribers",
  {
    limit: z.number().optional().default(20),
    filter: z
      .string()
      .optional()
      .describe("Ghost filter string, e.g. 'subscribed:true'"),
  },
  async ({ limit, filter }) => {
    const params = new URLSearchParams({
      limit: String(limit),
      fields: "id,name,email,subscribed,created_at",
    });
    if (filter) params.set("filter", filter);

    const data = await ghostFetch(`/members/?${params}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ── Tags ───────────────────────────────────────────────────────────────────────

server.tool(
  "list_tags",
  "List Ghost tags",
  { limit: z.number().optional().default(50) },
  async ({ limit }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    const data = await ghostFetch(`/tags/?${params}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ── Newsletters ────────────────────────────────────────────────────────────────

server.tool(
  "list_newsletters",
  "List Ghost newsletters",
  {},
  async () => {
    const data = await ghostFetch("/newsletters/");
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ── Site info ──────────────────────────────────────────────────────────────────

server.tool(
  "get_site",
  "Get Ghost site info and configuration",
  {},
  async () => {
    const data = await ghostFetch("/site/");
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ── Image generation ───────────────────────────────────────────────────────────

/**
 * Maps a Big Idea + optional mood into an abstract visual prompt for DALL-E 3.
 * Rules: no faces, no text, no recognisable people.
 * Palette: deep teal, indigo, charcoal, silver.
 * Atmosphere: tension between weight and lightness, shadow and light.
 * Somatic anchors: body, water, stone, mist, filtered light.
 */
function buildVisualPrompt(bigIdea: string, title: string, mood?: string): string {
  const moodHints: Record<string, string> = {
    dark:    "Deep shadows dominate. Rich charcoal and dark indigo. Minimal light sources.",
    light:   "Soft diffused brightness. Silver tones, near-white fog, gentle luminosity.",
    liminal: "Between states — neither day nor night, neither solid nor dissolved. Threshold quality.",
    somatic: "Emphasis on texture and physical sensation — stone, skin, water, breath made visible.",
  };

  const moodClause = mood && moodHints[mood] ? ` ${moodHints[mood]}` : "";

  return (
    `Abstract contemplative photograph or painting inspired by: "${bigIdea}". ` +
    `Post title context: "${title}". ` +
    `No faces, no text, no recognisable human figures. ` +
    `Deep teal, indigo, charcoal, and silver palette. ` +
    `Atmosphere of tension between weight and lightness, shadow and emerging light. ` +
    `Somatic anchors: still water, stone surfaces, filtered light, mist, breath.` +
    moodClause +
    ` Photographic or painterly quality — quiet, precise, emotionally resonant.`
  );
}

server.tool(
  "generate_post_image",
  "Generate an abstract contemplative feature image for a Ghost post using DALL-E 3",
  {
    big_idea: z.string().describe("The core idea of the post (1 sentence)"),
    title: z.string().describe("The post title or subject line"),
    mood: z
      .enum(["dark", "light", "liminal", "somatic"])
      .optional()
      .describe("Optional mood override for the visual palette"),
  },
  {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  async ({ big_idea, title, mood }) => {
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set in environment");
    }

    const promptUsed = buildVisualPrompt(big_idea, title, mood);

    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: promptUsed,
      n: 1,
      size: "1792x1024",
      quality: "standard",
      style: "natural",
    });

    const image = response.data?.[0];
    const imageUrl = image?.url ?? "";
    const revisedPrompt = image?.revised_prompt ?? promptUsed;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ url: imageUrl, prompt_used: promptUsed, revised_prompt: revisedPrompt }, null, 2),
        },
      ],
    };
  }
);

// ─── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  assertConfig();

  // Quick auth smoke-test: /site/ works with integration keys (no user context needed)
  try {
    await ghostFetch("/site/");
    console.error("[ghost-mcp] Auth OK — connected to", GHOST_URL);
  } catch (err) {
    console.error("[ghost-mcp] Auth FAILED:", (err as Error).message);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ghost-mcp] MCP server listening on stdio");
}

main().catch((err) => {
  console.error("[ghost-mcp] Fatal:", err);
  process.exit(1);
});
