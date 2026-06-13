# Ghost MCP

MCP server for Ghost CMS — lets Claude manage posts, pages, members, tags, and newsletters via the Ghost Admin API.

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials:

```
GHOST_URL=https://your-site.ghost.io
GHOST_ADMIN_KEY=your_key_id:your_key_secret
```

Get the **Staff Access Token** from Ghost Admin → Settings → Integrations → Add custom integration.

2. Install and build:

```bash
npm install
npm run build
```

3. Test auth before connecting Claude:

```bash
npm run dev
```

If auth succeeds you'll see `[ghost-mcp] Auth OK`. On failure, the process exits with the Ghost error.

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ghost": {
      "command": "node",
      "args": ["/absolute/path/to/claude-mcp-work/dist/ghost.js"],
      "env": {
        "GHOST_URL": "https://your-site.ghost.io",
        "GHOST_ADMIN_KEY": "your_key_id:your_key_secret"
      }
    }
  }
}
```

## Available tools

| Tool | Description |
|---|---|
| `list_posts` | List posts (filter by status, paginate) |
| `get_post` | Get post by ID or slug |
| `create_post` | Create draft or published post |
| `update_post` | Update post (requires `updated_at` for concurrency) |
| `delete_post` | Delete a post |
| `list_pages` | List static pages |
| `create_page` | Create a static page |
| `list_members` | List members/subscribers |
| `list_tags` | List tags |
| `list_newsletters` | List newsletters |
| `get_site` | Get site info |
