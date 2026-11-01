import type { ConnectorDef, ConnectorEase, ConnectorOAuthOverrides, ConnectorVariant } from './types'

/**
 * The connector catalog: curated presets for official remote MCP servers of outside services. Pure data,
 * structured-clone safe; connectors:add (src/main/mcp/connectors.ts) turns a preset into an app-wide MCP library
 * entry. Nothing here was tested against the live services (every `verified` is false): URLs, scopes and setup
 * steps come from the vendors' docs as of late 2026 (newer entries and corrections: docs read 2026-10-31).
 */

/**
 * The fixed loopback port of the OAuth redirect for 'oauthClient' connectors. Users register
 * CONNECTOR_REDIRECT_URI in the vendor's console, so the port cannot be random: the flow listens on exactly this
 * port and fails with a clear message when another program holds it (no ephemeral fallback, which the vendor
 * would reject as a redirect_uri mismatch). DCR connectors keep the ephemeral port they register with.
 */
export const CONNECTOR_REDIRECT_PORT = 38917
export const CONNECTOR_REDIRECT_URI = `http://127.0.0.1:${CONNECTOR_REDIRECT_PORT}/callback`

/** Authorization-URL parameters a preset may never set through extraAuthParams. */
export const RESERVED_AUTH_PARAMS: readonly string[] = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'scope'
]

const GOOGLE_OAUTH: ConnectorOAuthOverrides = {
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  endpointsMode: 'replace',
  // A refresh token needs offline access; prompt=consent re-issues it on a repeat authorization.
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  // Google's endpoints do not document RFC 8707 resource indicators.
  sendResource: false
}

const GOOGLE_MCP_GUIDE = 'https://developers.google.com/workspace/guides/configure-mcp-servers'

const googleSetup = (api: string): string[] => [
  `Join Google's Workspace Developer Preview Program with your account (a prerequisite for its MCP servers; see ${GOOGLE_MCP_GUIDE}).`,
  'In the Google Cloud console, create (or pick) a project.',
  `Enable the ${api} and its MCP server for that project.`,
  'Configure the OAuth consent screen; while it is in Testing, add your Google account as a test user.',
  'Create an OAuth client of type "Web application" and tick "Use this client for an AI-powered agent".',
  `Add ${CONNECTOR_REDIRECT_URI} as an authorized redirect URI.`,
  'Paste the client id and client secret into OrgAI, then Authorize.'
]

const GOOGLE_NOTES = [
  'Google lists its Workspace MCP servers as a Developer Preview: your account must be in the Developer Preview Program, and the OAuth client must have "Use this client for an AI-powered agent" ticked.',
  `Unverified: that Google accepts the loopback redirect ${CONNECTOR_REDIRECT_URI} for a Web application client (a Desktop app client also accepts loopback redirects).`
]

const google = (
  id: string,
  name: string,
  category: ConnectorDef['category'],
  description: string,
  url: string,
  api: string,
  scopes: string[],
  docsUrl: string,
  aliases: string[],
  extraNotes: string[] = []
): ConnectorDef => ({
  id,
  name,
  vendor: 'Google',
  publisher: 'official',
  category,
  description,
  status: 'preview',
  docsUrl,
  variants: [
    {
      id: 'readonly',
      label: 'Read-only',
      transport: 'http',
      url,
      readOnly: true,
      auth: { kind: 'oauthClient', scopes, overrides: GOOGLE_OAUTH, consoleUrl: 'https://console.cloud.google.com/apis/credentials', clientSecret: 'required' }
    }
  ],
  defaultVariant: 'readonly',
  setup: googleSetup(api),
  notes: [...GOOGLE_NOTES, ...extraNotes],
  aliases,
  verified: false
})

const dcrSetup = (service: string): string[] => [
  `Add the connector, then Authorize: your browser opens ${service}'s sign-in page.`,
  'Approve access, then return to OrgAI.',
  'Link it to a project and grant it to the roles that need it.'
]

const noAuthSetup = (service: string): string[] => [
  `Add the connector: ${service} needs no sign-in.`,
  'Test it, then link it to a project and grant it to the roles that need it.'
]

const ownAppSetup = (service: string, steps: string[]): string[] => [
  ...steps,
  `Register ${CONNECTOR_REDIRECT_URI} as the app's redirect URL.`,
  `Paste the app's client id and client secret into OrgAI, then Authorize (your browser opens ${service}'s sign-in page).`
]

const DCR_UNVERIFIED =
  'Unverified: that the server accepts dynamic client registration with a loopback redirect. If it asks for a client id, it needs an app registered in its developer console.'

const tokenAuth = (label: string, help: string, link: string): ConnectorVariant['auth'] => ({ kind: 'token', header: 'Authorization', prefix: 'Bearer ', label, help, link })

export const CONNECTORS: readonly ConnectorDef[] = [
  google(
    'gmail',
    'Gmail',
    'email',
    'Search and read your Gmail messages and threads.',
    'https://gmailmcp.googleapis.com/mcp/v1',
    'Gmail API',
    ['https://www.googleapis.com/auth/gmail.readonly'],
    'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
    ['email', 'mail', 'google mail', 'inbox']
  ),
  google(
    'google-calendar',
    'Google Calendar',
    'calendar',
    'Read your calendars, events and free/busy times.',
    'https://calendarmcp.googleapis.com/mcp/v1',
    'Google Calendar API',
    [
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
    ],
    'https://docs.cloud.google.com/mcp/overview',
    ['calendar', 'events', 'schedule', 'meetings']
  ),
  google(
    'google-drive',
    'Google Drive',
    'files',
    'Search and read files in your Google Drive.',
    'https://drivemcp.googleapis.com/mcp/v1',
    'Google Drive API',
    ['https://www.googleapis.com/auth/drive.readonly'],
    'https://docs.cloud.google.com/mcp/overview',
    ['files', 'storage', 'documents', 'gdrive']
  ),
  google(
    'google-docs',
    'Google Docs',
    'docs',
    'Read your Google Docs documents.',
    'https://docsmcp.googleapis.com/mcp/v1',
    'Google Docs API',
    ['https://www.googleapis.com/auth/documents.readonly'],
    GOOGLE_MCP_GUIDE,
    ['documents', 'writing', 'word processing', 'gdocs']
  ),
  google(
    'google-sheets',
    'Google Sheets',
    'data',
    'Read your Google Sheets spreadsheets.',
    'https://sheetsmcp.googleapis.com/mcp/v1',
    'Google Sheets API',
    ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    GOOGLE_MCP_GUIDE,
    ['spreadsheets', 'tables', 'excel', 'gsheets']
  ),
  google(
    'google-slides',
    'Google Slides',
    'docs',
    'Read your Google Slides presentations.',
    'https://slidesmcp.googleapis.com/mcp/v1',
    'Google Slides API',
    ['https://www.googleapis.com/auth/presentations.readonly'],
    GOOGLE_MCP_GUIDE,
    ['presentations', 'decks', 'slides', 'powerpoint']
  ),
  google(
    'google-chat',
    'Google Chat',
    'chat',
    'Search and read your Google Chat spaces and messages.',
    'https://chatmcp.googleapis.com/mcp/v1',
    'Google Chat API',
    ['https://www.googleapis.com/auth/chat.spaces.readonly', 'https://www.googleapis.com/auth/chat.messages.readonly'],
    GOOGLE_MCP_GUIDE,
    ['messages', 'team chat', 'spaces', 'hangouts'],
    ['The Google Chat API may also need a Chat app configured in the same Cloud project.']
  ),
  {
    id: 'slack',
    name: 'Slack',
    vendor: 'Slack',
    publisher: 'official',
    category: 'chat',
    description: 'Search and read Slack messages, channels and users.',
    status: 'preview',
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
    variants: [
      {
        id: 'full',
        label: 'Full access',
        transport: 'http',
        url: 'https://mcp.slack.com/mcp',
        readOnly: false,
        auth: {
          kind: 'oauthClient',
          overrides: {
            issuer: 'https://slack.com',
            authorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize',
            tokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
            endpointsMode: 'fallback',
            sendResource: false,
            tokenResponse: 'slackUser'
          },
          consoleUrl: 'https://api.slack.com/apps',
          clientSecret: 'required'
        }
      }
    ],
    defaultVariant: 'full',
    setup: [
      'At api.slack.com/apps, create a Slack app for your workspace (Slack offers no dynamic client registration).',
      `Under OAuth & Permissions, add the redirect URL ${CONNECTOR_REDIRECT_URI} and the user scopes the MCP server needs.`,
      'Have a workspace admin approve the app if your workspace requires it.',
      'Paste the app\'s client id and client secret into OrgAI, then Authorize.'
    ],
    notes: [
      'Slack has no dynamic client registration: it needs a registered Slack app, and only apps published in the Slack Marketplace or internal to your workspace may use the MCP server.',
      'The server includes write tools (sending messages); grant it only to roles that should act in Slack.',
      'Slack documents that redirect URLs must use HTTPS, so it may refuse OrgAI\'s http loopback redirect. Unverified.',
      'Unverified: the token response shape of oauth.v2.user.access and which scopes the server expects (OrgAI uses the scopes Slack\'s discovery metadata lists).',
      'The server\'s own authorization metadata names the issuer https://mcp.slack.com, not slack.com (probed 2026-10-31); the slack.com issuer and endpoints here are used only when discovery fails.'
    ],
    aliases: ['chat', 'messages', 'channels', 'team chat'],
    verified: false
  },
  {
    id: 'notion',
    name: 'Notion',
    vendor: 'Notion',
    publisher: 'official',
    category: 'docs',
    description: 'Search and read Notion pages and databases.',
    status: 'stable',
    docsUrl: 'https://developers.notion.com/docs/mcp',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.notion.com/mcp', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('Notion'),
    notes: ['The server includes write tools (creating and editing pages).', DCR_UNVERIFIED],
    aliases: ['wiki', 'notes', 'pages', 'knowledge base'],
    verified: false
  },
  {
    id: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    publisher: 'official',
    category: 'project',
    description: 'Find and read Linear issues, projects and comments.',
    status: 'stable',
    docsUrl: 'https://linear.app/docs/mcp',
    variants: [
      {
        id: 'readonly',
        label: 'Read-only',
        description: 'Only the read tools.',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp/readonly',
        readOnly: true,
        auth: { kind: 'oauth' }
      },
      {
        id: 'full',
        label: 'Full access',
        description: 'Read and write tools (create and update issues).',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        readOnly: false,
        auth: { kind: 'oauth' }
      }
    ],
    defaultVariant: 'readonly',
    setup: dcrSetup('Linear'),
    aliases: ['issues', 'tickets', 'bugs', 'project management'],
    verified: false
  },
  {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    publisher: 'official',
    category: 'dev',
    description: 'Read repositories, issues, pull requests and code on GitHub.',
    status: 'stable',
    docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    variants: [
      {
        id: 'readonly',
        label: 'Read-only',
        description: 'Only the read tools (X-MCP-Readonly header).',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { 'X-MCP-Readonly': 'true' },
        readOnly: true,
        auth: tokenAuth(
          'Personal access token',
          'A fine-grained token with read access to the repositories agents should see.',
          'https://github.com/settings/personal-access-tokens/new'
        )
      },
      {
        id: 'full',
        label: 'Full access',
        description: 'Read and write tools; the token\'s permissions still apply.',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        readOnly: false,
        auth: tokenAuth(
          'Personal access token',
          'A fine-grained token with the repository permissions agents need.',
          'https://github.com/settings/personal-access-tokens/new'
        )
      }
    ],
    defaultVariant: 'readonly',
    setup: ['Create a fine-grained personal access token on GitHub.', 'Paste it into OrgAI and test the connection.'],
    notes: ['The token is stored with Electron safeStorage and sent as Authorization: Bearer.'],
    aliases: ['git', 'code', 'repositories', 'pull requests', 'issues'],
    verified: false
  },
  {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    publisher: 'official',
    category: 'monitoring',
    description: 'Look up Sentry issues, events and releases.',
    status: 'stable',
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.sentry.dev/mcp', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('Sentry'),
    notes: [DCR_UNVERIFIED],
    aliases: ['errors', 'crashes', 'exceptions', 'error tracking'],
    verified: false
  },
  {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    publisher: 'official',
    category: 'payments',
    description: 'Look up Stripe customers, payments and subscriptions.',
    status: 'stable',
    docsUrl: 'https://docs.stripe.com/mcp',
    variants: [
      { id: 'oauth', label: 'Sign in with Stripe', transport: 'http', url: 'https://mcp.stripe.com', readOnly: false, auth: { kind: 'oauth' } },
      {
        id: 'key',
        label: 'Agent API key',
        description: 'A restricted key with the Agent tag; its permissions decide what agents can do.',
        transport: 'http',
        url: 'https://mcp.stripe.com',
        readOnly: false,
        auth: tokenAuth(
          'Agent API key',
          'A restricted key (rk_...) tagged for agent use, with only the read permissions agents need. Full secret keys stop working in December 2026.',
          'https://dashboard.stripe.com/apikeys'
        )
      }
    ],
    defaultVariant: 'oauth',
    setup: dcrSetup('Stripe'),
    notes: [
      'The server includes write tools (creating customers, refunds).',
      'From December 2026 Stripe\'s MCP server refuses full secret keys and restricted keys without the Agent tag; use Sign in with Stripe or an agent API key.'
    ],
    aliases: ['payments', 'billing', 'subscriptions', 'invoices'],
    verified: false
  },
  {
    id: 'figma',
    name: 'Figma',
    vendor: 'Figma',
    publisher: 'official',
    category: 'design',
    description: 'Read Figma files, frames and design tokens.',
    status: 'preview',
    docsUrl: 'https://help.figma.com/hc/en-us/articles/32132100833559',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.figma.com/mcp', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('Figma'),
    notes: ['Unverified: that Figma\'s remote server accepts clients other than the ones it lists.', DCR_UNVERIFIED],
    aliases: ['design', 'mockups', 'prototypes', 'ui'],
    verified: false
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    vendor: 'Atlassian',
    publisher: 'official',
    category: 'project',
    description: 'Search and read Jira issues and Confluence pages.',
    status: 'preview',
    docsUrl: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.atlassian.com/v2/mcp', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: [...dcrSetup('Atlassian'), 'If sign-in is refused, an organization admin may need to allow the client domain in Atlassian Administration.'],
    notes: ['The server includes write tools (creating issues and pages).', 'Unverified: that Atlassian accepts a loopback redirect.'],
    aliases: ['jira', 'confluence', 'issues', 'tickets', 'wiki'],
    verified: false
  },
  // ---------- added 2026-10-31 (vendor docs read that day; none tested live) ----------
  {
    id: 'intercom',
    name: 'Intercom',
    vendor: 'Intercom',
    publisher: 'official',
    category: 'crm',
    description: 'Search and read Intercom conversations, contacts and tickets.',
    status: 'preview',
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    variants: [
      { id: 'us', label: 'US workspace', transport: 'http', url: 'https://mcp.intercom.com/mcp', readOnly: false, auth: { kind: 'oauth' } },
      { id: 'eu', label: 'EU workspace', transport: 'http', url: 'https://mcp.eu.intercom.com/mcp', readOnly: false, auth: { kind: 'oauth' } }
    ],
    defaultVariant: 'us',
    setup: dcrSetup('Intercom'),
    notes: [
      'Pick the variant for the region your workspace is hosted in.',
      'Intercom documents dynamic client registration and loopback redirects on 127.0.0.1 with any port. Unverified with OrgAI.'
    ],
    aliases: ['support', 'customer support', 'helpdesk', 'conversations', 'tickets'],
    verified: false
  },
  {
    id: 'supabase',
    name: 'Supabase',
    vendor: 'Supabase',
    publisher: 'official',
    category: 'cloud',
    description: 'Query Supabase projects, tables, logs and docs.',
    status: 'stable',
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    variants: [
      {
        id: 'readonly',
        label: 'Read-only',
        description: 'SQL runs as a read-only database user.',
        transport: 'http',
        url: 'https://mcp.supabase.com/mcp?read_only=true',
        readOnly: true,
        auth: { kind: 'oauth' }
      },
      {
        id: 'full',
        label: 'Full access',
        description: 'Can change schemas, data and project settings.',
        transport: 'http',
        url: 'https://mcp.supabase.com/mcp',
        readOnly: false,
        auth: { kind: 'oauth' }
      }
    ],
    defaultVariant: 'readonly',
    setup: dcrSetup('Supabase'),
    notes: [
      'Supabase advises connecting a development project, not production.',
      'Unverified: dynamic client registration with OrgAI, and that the read_only query parameter is accepted as part of the OAuth resource.'
    ],
    aliases: ['database', 'postgres', 'sql', 'backend'],
    verified: false
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    vendor: 'Cognition',
    publisher: 'official',
    category: 'knowledge',
    description: 'Ask questions about public GitHub repositories and read their generated docs.',
    status: 'stable',
    docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    variants: [{ id: 'public', label: 'Public repositories', transport: 'http', url: 'https://mcp.deepwiki.com/mcp', readOnly: true, auth: { kind: 'none' } }],
    defaultVariant: 'public',
    setup: noAuthSetup('DeepWiki'),
    notes: ['Public repositories only; private repositories need a Devin account, which OrgAI does not set up.'],
    aliases: ['repository docs', 'code questions', 'github', 'documentation', 'wiki'],
    verified: false
  },
  {
    id: 'exa',
    name: 'Exa',
    vendor: 'Exa',
    publisher: 'official',
    category: 'knowledge',
    description: 'Search the web and read pages for research.',
    status: 'stable',
    docsUrl: 'https://docs.exa.ai/reference/exa-mcp',
    variants: [
      {
        id: 'free',
        label: 'Without a key',
        description: 'No sign-in; Exa applies its free usage limits.',
        transport: 'http',
        url: 'https://mcp.exa.ai/mcp',
        readOnly: true,
        auth: { kind: 'none' }
      },
      {
        id: 'key',
        label: 'With an API key',
        description: 'Uses your Exa plan and its limits.',
        transport: 'http',
        url: 'https://mcp.exa.ai/mcp',
        readOnly: true,
        auth: { kind: 'token', header: 'x-api-key', label: 'Exa API key', help: 'An API key from your Exa dashboard.', link: 'https://dashboard.exa.ai/api-keys' }
      }
    ],
    defaultVariant: 'free',
    setup: noAuthSetup('Exa'),
    notes: ['Without a key Exa rate-limits requests; add a key for heavier use.'],
    aliases: ['web search', 'search', 'research', 'crawl'],
    verified: false
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    vendor: 'Cloudflare',
    publisher: 'official',
    category: 'cloud',
    description: 'Work with your Cloudflare account: Workers, DNS, storage and docs.',
    status: 'stable',
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    variants: [
      { id: 'oauth', label: 'Sign in with Cloudflare', transport: 'http', url: 'https://mcp.cloudflare.com/mcp', readOnly: false, auth: { kind: 'oauth' } },
      {
        id: 'token',
        label: 'API token',
        description: 'The token\'s permissions decide what agents can do.',
        transport: 'http',
        url: 'https://mcp.cloudflare.com/mcp',
        readOnly: false,
        auth: tokenAuth('API token', 'A Cloudflare API token limited to the accounts and permissions agents need.', 'https://dash.cloudflare.com/profile/api-tokens')
      }
    ],
    defaultVariant: 'oauth',
    setup: dcrSetup('Cloudflare'),
    notes: ['The server can change account resources (deploy Workers, edit DNS).', DCR_UNVERIFIED],
    aliases: ['workers', 'dns', 'cdn', 'edge', 'hosting'],
    verified: false
  },
  {
    id: 'datadog',
    name: 'Datadog',
    vendor: 'Datadog',
    publisher: 'official',
    category: 'monitoring',
    description: 'Search Datadog logs, metrics, traces, monitors and incidents.',
    status: 'preview',
    docsUrl: 'https://docs.datadoghq.com/mcp_server/setup',
    variants: [
      { id: 'us1', label: 'US1 site', description: 'app.datadoghq.com', transport: 'http', url: 'https://mcp.datadoghq.com/v1/mcp', readOnly: false, auth: { kind: 'oauth' } },
      { id: 'eu1', label: 'EU1 site', description: 'app.datadoghq.eu', transport: 'http', url: 'https://mcp.datadoghq.eu/v1/mcp', readOnly: false, auth: { kind: 'oauth' } },
      {
        id: 'us3',
        label: 'US3 site',
        description: 'us3.datadoghq.com',
        transport: 'http',
        url: 'https://mcp.us3.datadoghq.com/v1/mcp',
        readOnly: false,
        auth: { kind: 'oauth' }
      },
      {
        id: 'us5',
        label: 'US5 site',
        description: 'us5.datadoghq.com',
        transport: 'http',
        url: 'https://mcp.us5.datadoghq.com/v1/mcp',
        readOnly: false,
        auth: { kind: 'oauth' }
      },
      {
        id: 'ap1',
        label: 'AP1 site',
        description: 'ap1.datadoghq.com',
        transport: 'http',
        url: 'https://mcp.ap1.datadoghq.com/v1/mcp',
        readOnly: false,
        auth: { kind: 'oauth' }
      }
    ],
    defaultVariant: 'us1',
    setup: dcrSetup('Datadog'),
    notes: [
      'Pick the variant for your Datadog site (the host in your Datadog web address).',
      'The US3, US5 and AP1 addresses follow the US1 and EU1 pattern; a token-free probe on 2026-10-31 found all three answering.',
      DCR_UNVERIFIED
    ],
    aliases: ['logs', 'metrics', 'traces', 'observability', 'apm'],
    verified: false
  },
  {
    id: 'vercel',
    name: 'Vercel',
    vendor: 'Vercel',
    publisher: 'official',
    category: 'cloud',
    description: 'Look up Vercel projects, deployments and build logs.',
    status: 'preview',
    docsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.vercel.com', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('Vercel'),
    notes: ['Vercel only allows MCP clients it has reviewed, so it may refuse OrgAI\'s sign-in.', DCR_UNVERIFIED],
    aliases: ['deployments', 'hosting', 'next.js', 'frontend'],
    verified: false
  },
  {
    id: 'asana',
    name: 'Asana',
    vendor: 'Asana',
    publisher: 'official',
    category: 'project',
    description: 'Find and read Asana tasks, projects and goals.',
    status: 'stable',
    docsUrl: 'https://developers.asana.com/docs/integrating-with-asanas-mcp-server',
    variants: [
      {
        id: 'full',
        label: 'Full access',
        transport: 'http',
        url: 'https://mcp.asana.com/v2/mcp',
        readOnly: false,
        auth: { kind: 'oauthClient', overrides: { issuer: 'https://app.asana.com' }, consoleUrl: 'https://app.asana.com/0/my-apps', clientSecret: 'required' }
      }
    ],
    defaultVariant: 'full',
    setup: ownAppSetup('Asana', ['In the Asana developer console, create an app for the MCP server (Asana offers no dynamic client registration).']),
    notes: [
      'The server includes write tools (creating and updating tasks).',
      'Unverified: that Asana accepts an http loopback redirect URL.',
      'The issuer https://app.asana.com is taken from the server\'s authorization metadata (probed 2026-10-31) and enforced: sign-in is refused when the server names another issuer or sign-in endpoints outside its domain. Unverified in a live sign-in.'
    ],
    aliases: ['tasks', 'projects', 'project management', 'to-do'],
    verified: false
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    vendor: 'HubSpot',
    publisher: 'official',
    category: 'crm',
    description: 'Search and read HubSpot contacts, companies and deals.',
    status: 'stable',
    docsUrl: 'https://developers.hubspot.com/mcp',
    variants: [
      {
        id: 'full',
        label: 'Full access',
        transport: 'http',
        url: 'https://mcp.hubspot.com',
        readOnly: false,
        auth: { kind: 'oauthClient', overrides: { issuer: 'https://mcp.hubspot.com' }, consoleUrl: 'https://developers.hubspot.com/mcp', clientSecret: 'required' }
      }
    ],
    defaultVariant: 'full',
    setup: ownAppSetup('HubSpot', ['Following HubSpot\'s MCP guide, create a user-level developer app for the MCP server in your HubSpot account.']),
    notes: ['Unverified: that HubSpot accepts an http loopback redirect URL, and which scopes the app needs.', 'The issuer https://mcp.hubspot.com is taken from the server\'s authorization metadata (probed 2026-10-31) and enforced: sign-in is refused when the server names another issuer or sign-in endpoints outside its domain. Unverified in a live sign-in.'],
    aliases: ['crm', 'contacts', 'deals', 'sales', 'marketing'],
    verified: false
  },
  {
    id: 'box',
    name: 'Box',
    vendor: 'Box',
    publisher: 'official',
    category: 'files',
    description: 'Search and read files and folders in Box.',
    status: 'stable',
    docsUrl: 'https://developer.box.com/guides/box-mcp/',
    variants: [
      {
        id: 'full',
        label: 'Full access',
        transport: 'http',
        url: 'https://mcp.box.com',
        readOnly: false,
        auth: { kind: 'oauthClient', overrides: { issuer: 'https://api.box.com' }, consoleUrl: 'https://app.box.com/developers/console', clientSecret: 'required' }
      }
    ],
    defaultVariant: 'full',
    setup: ownAppSetup('Box', [
      'Ask a Box admin to enable the Box MCP server for your enterprise.',
      'In the Box developer console, create the MCP integration and copy its Integration Credentials (client id and secret).'
    ]),
    notes: ['A Box admin must enable the MCP server first.', 'Unverified: that Box accepts an http loopback redirect URL.', 'The issuer https://api.box.com is taken from the server\'s authorization metadata (probed 2026-10-31) and enforced: sign-in is refused when the server names another issuer or sign-in endpoints outside its domain. Unverified in a live sign-in.'],
    aliases: ['files', 'documents', 'storage', 'cloud storage'],
    verified: false
  },
  {
    id: 'paypal',
    name: 'PayPal',
    vendor: 'PayPal',
    publisher: 'official',
    category: 'payments',
    description: 'Look up PayPal invoices, orders, transactions and disputes.',
    status: 'stable',
    docsUrl: 'https://developer.paypal.com/tools/mcp-server/',
    variants: [
      { id: 'live', label: 'Live account', transport: 'http', url: 'https://mcp.paypal.com/http', readOnly: false, auth: { kind: 'oauth' } },
      {
        id: 'sandbox',
        label: 'Sandbox',
        description: 'PayPal\'s test environment; no real money moves.',
        transport: 'http',
        url: 'https://mcp.sandbox.paypal.com/http',
        readOnly: false,
        auth: { kind: 'oauth' }
      }
    ],
    defaultVariant: 'live',
    setup: dcrSetup('PayPal'),
    notes: [
      'The server includes write tools (creating invoices, refunds); try the Sandbox variant first.',
      'Unverified: how PayPal\'s server authenticates. OrgAI tries sign-in with dynamic client registration; if it asks for a client id, create a REST app in the PayPal developer dashboard.',
      'A token-free probe on 2026-10-31 got 404 (not 401) from POST /http although resource metadata exists, so the server address may be wrong.'
    ],
    aliases: ['payments', 'invoices', 'transactions', 'checkout'],
    verified: false
  },
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    vendor: 'Microsoft',
    publisher: 'official',
    category: 'knowledge',
    description: 'Search and read Microsoft and Azure documentation and code samples.',
    status: 'stable',
    docsUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
    variants: [{ id: 'public', label: 'Public docs', transport: 'http', url: 'https://learn.microsoft.com/api/mcp', readOnly: true, auth: { kind: 'none' } }],
    defaultVariant: 'public',
    setup: noAuthSetup('Microsoft Learn'),
    notes: ['Public documentation only; it cannot reach your Microsoft or Azure account.'],
    aliases: ['microsoft docs', 'ms learn', 'azure docs', 'documentation', 'dotnet'],
    verified: false
  },
  {
    id: 'aws-knowledge',
    name: 'AWS Knowledge',
    vendor: 'Amazon Web Services',
    publisher: 'official',
    category: 'knowledge',
    description: 'Search AWS documentation, guidance and regional availability.',
    status: 'stable',
    docsUrl: 'https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server',
    variants: [{ id: 'public', label: 'Public docs', transport: 'http', url: 'https://knowledge-mcp.global.api.aws', readOnly: true, auth: { kind: 'none' } }],
    defaultVariant: 'public',
    setup: noAuthSetup('AWS Knowledge'),
    notes: ['Public documentation only; it cannot reach your AWS account.', 'AWS rate-limits the server, so heavy use may be throttled.'],
    aliases: ['aws docs', 'amazon docs', 'amazon', 'documentation', 'cloud docs'],
    verified: false
  },
  {
    id: 'context7',
    name: 'Context7',
    vendor: 'Upstash',
    publisher: 'official',
    category: 'knowledge',
    description: 'Fetch current documentation and examples for libraries and frameworks.',
    status: 'stable',
    docsUrl: 'https://context7.com/docs/resources/all-clients',
    variants: [
      {
        id: 'free',
        label: 'Without a key',
        description: 'No sign-in; Context7 applies its free limits.',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        readOnly: true,
        auth: { kind: 'none' }
      },
      {
        id: 'key',
        label: 'With an API key',
        description: 'Higher limits on your Context7 account.',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        readOnly: true,
        auth: tokenAuth('Context7 API key', 'An API key from your Context7 dashboard.', 'https://context7.com/dashboard')
      }
    ],
    defaultVariant: 'free',
    setup: noAuthSetup('Context7'),
    notes: [
      'A token-free probe on 2026-10-31 found that the server answers without a key; add a key for higher limits.',
      'To switch to the key variant later, remove the connector and add it again with a key.'
    ],
    aliases: ['library docs', 'package docs', 'upstash', 'documentation', 'frameworks'],
    verified: false
  },
  {
    id: 'granola',
    name: 'Granola',
    vendor: 'Granola',
    publisher: 'official',
    category: 'meetings',
    description: 'Search and read your Granola meeting notes and transcripts.',
    status: 'stable',
    docsUrl: 'https://docs.granola.ai/help-center/sharing/integrations/mcp',
    variants: [{ id: 'full', label: 'Your notes', transport: 'http', url: 'https://mcp.granola.ai/mcp', readOnly: true, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('Granola'),
    notes: ['Granola documents dynamic client registration for its MCP server.', DCR_UNVERIFIED],
    aliases: ['meeting notes', 'transcripts', 'notes', 'meetings'],
    verified: false
  },
  {
    id: 'neon',
    name: 'Neon',
    vendor: 'Neon',
    publisher: 'official',
    category: 'cloud',
    description: 'Query and manage your Neon Postgres projects, branches and databases.',
    status: 'stable',
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    variants: [
      { id: 'readonly', label: 'Read-only', transport: 'http', url: 'https://mcp.neon.tech/mcp?readonly=true', readOnly: true, auth: { kind: 'oauth' } },
      { id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.neon.tech/mcp', readOnly: false, auth: { kind: 'oauth' } },
      {
        id: 'key',
        label: 'API key',
        description: 'The key\'s account decides what agents can reach.',
        transport: 'http',
        url: 'https://mcp.neon.tech/mcp',
        readOnly: false,
        auth: tokenAuth('Neon API key', 'A Neon API key with only the access agents need.', 'https://console.neon.tech/app/settings/api-keys')
      }
    ],
    defaultVariant: 'readonly',
    setup: dcrSetup('Neon'),
    notes: [
      'Full access can create and delete projects, branches and databases.',
      'The server advertises dynamic client registration (probed 2026-10-31).',
      DCR_UNVERIFIED
    ],
    aliases: ['postgres', 'database', 'sql', 'serverless postgres'],
    verified: false
  },
  {
    id: 'amplitude',
    name: 'Amplitude',
    vendor: 'Amplitude',
    publisher: 'official',
    category: 'data',
    description: 'Query Amplitude charts, dashboards, events and experiments.',
    status: 'stable',
    docsUrl: 'https://amplitude.com/docs/amplitude-ai/amplitude-mcp/other-clients',
    variants: [
      { id: 'us', label: 'US data center', transport: 'http', url: 'https://mcp.amplitude.com/mcp', readOnly: false, auth: { kind: 'oauth' } },
      { id: 'eu', label: 'EU data center', transport: 'http', url: 'https://mcp.eu.amplitude.com/mcp', readOnly: false, auth: { kind: 'oauth' } }
    ],
    defaultVariant: 'us',
    setup: dcrSetup('Amplitude'),
    notes: ['Pick the variant for the data center your Amplitude organization uses.', DCR_UNVERIFIED],
    aliases: ['analytics', 'product analytics', 'events', 'experiments'],
    verified: false
  },
  {
    id: 'posthog',
    name: 'PostHog',
    vendor: 'PostHog',
    publisher: 'official',
    category: 'data',
    description: 'Query PostHog insights, events, feature flags and errors.',
    status: 'stable',
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.posthog.com/mcp', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('PostHog'),
    notes: [
      'The server can change feature flags and other project settings.',
      'Sign-in runs at oauth.posthog.com, which advertises dynamic client registration and client id metadata documents (probed 2026-10-31).',
      DCR_UNVERIFIED
    ],
    aliases: ['analytics', 'product analytics', 'feature flags', 'session replay', 'events'],
    verified: false
  },
  {
    id: 'webflow',
    name: 'Webflow',
    vendor: 'Webflow',
    publisher: 'official',
    category: 'design',
    description: 'Read and edit Webflow sites, pages and CMS collections.',
    status: 'stable',
    docsUrl: 'https://developers.webflow.com/mcp/reference/how-it-works',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.webflow.com/mcp', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('Webflow'),
    notes: ['The server can change site content and CMS items.', DCR_UNVERIFIED],
    aliases: ['website', 'cms', 'site builder', 'web design'],
    verified: false
  },
  {
    id: 'miro',
    name: 'Miro',
    vendor: 'Miro',
    publisher: 'official',
    category: 'design',
    description: 'Read Miro boards and create diagrams and content on them.',
    status: 'preview',
    docsUrl: 'https://developers.miro.com/docs/connecting-to-miro-mcp',
    variants: [{ id: 'full', label: 'Full access', transport: 'http', url: 'https://mcp.miro.com/', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('Miro'),
    notes: ['The server can add content to boards.', DCR_UNVERIFIED],
    aliases: ['whiteboard', 'boards', 'diagrams', 'brainstorming'],
    verified: false
  },
  {
    id: 'zoom',
    name: 'Zoom',
    vendor: 'Zoom',
    publisher: 'official',
    category: 'meetings',
    description: 'Look up Zoom meetings, recordings and meeting summaries.',
    status: 'preview',
    docsUrl: 'https://developers.zoom.us/docs/mcp/servers/',
    variants: [
      {
        id: 'full',
        label: 'Meetings',
        transport: 'http',
        url: 'https://zoom.us/mcp/meeting/streamable',
        readOnly: false,
        auth: { kind: 'oauthClient', overrides: { issuer: 'https://zoom.us' }, consoleUrl: 'https://marketplace.zoom.us/develop/create', clientSecret: 'required' }
      }
    ],
    defaultVariant: 'full',
    setup: ownAppSetup('Zoom', [
      'In the Zoom App Marketplace, choose Develop > Build App and create a General app (Zoom offers no dynamic client registration).',
      'Add the meeting scopes the MCP server needs and enable the app for your account.'
    ]),
    notes: [
      'Zoom offers neither dynamic client registration nor client id metadata documents, so it needs an app you register.',
      'The server\'s resource metadata names https://mcp.zoom.us/mcp/meeting/streamable, not the documented address (probed 2026-10-31); sign-in may fail on that mismatch.',
      'The issuer https://zoom.us is taken from the server\'s authorization metadata (probed 2026-10-31) and enforced: sign-in is refused when the server names another issuer or sign-in endpoints outside its domain. Unverified in a live sign-in.',
      'Unverified: that Zoom accepts an http loopback redirect URL, and which scopes the server needs.'
    ],
    aliases: ['video calls', 'meetings', 'recordings', 'video conferencing'],
    verified: false
  },
  {
    id: 'zapier',
    name: 'Zapier',
    vendor: 'Zapier',
    publisher: 'official',
    category: 'automation',
    description: 'Run the actions you enabled in Zapier across thousands of apps.',
    status: 'stable',
    docsUrl: 'https://docs.zapier.com/mcp/overview',
    variants: [
      {
        id: 'token',
        label: 'Connection token',
        description: 'Agents can run only the actions you enable for this connection.',
        transport: 'http',
        url: 'https://mcp.zapier.com/api/v1/connect',
        readOnly: false,
        auth: tokenAuth('Connection token', 'The token of an MCP connection you set up in Zapier, with only the actions agents need.', 'https://mcp.zapier.com/')
      }
    ],
    defaultVariant: 'token',
    setup: [
      'At mcp.zapier.com, create an MCP connection and enable the actions agents may run.',
      'Copy the connection\'s token and paste it into OrgAI.',
      'Link it to a project and grant it to the roles that need it.'
    ],
    notes: ['Each action runs in your connected apps (sending email, creating records); enable only what agents need.', 'Zapier counts tool calls against your plan\'s task limits.'],
    aliases: ['workflows', 'integrations', 'zaps', 'no-code'],
    verified: false
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    vendor: 'GitLab',
    publisher: 'official',
    category: 'dev',
    description: 'Read GitLab issues, merge requests, pipelines and code on gitlab.com.',
    status: 'preview',
    docsUrl: 'https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server',
    variants: [{ id: 'full', label: 'gitlab.com', transport: 'http', url: 'https://gitlab.com/api/v4/mcp', readOnly: false, auth: { kind: 'oauth' } }],
    defaultVariant: 'full',
    setup: dcrSetup('GitLab'),
    notes: [
      'gitlab.com only: a self-managed GitLab needs a custom server with your instance\'s address.',
      'The server can create issues and merge requests.',
      DCR_UNVERIFIED
    ],
    aliases: ['git', 'repositories', 'merge requests', 'ci', 'pipelines'],
    verified: false
  }
]

/*
 * Not yet in the catalog (checked 2026-10-31):
 * - Canva: its MCP server accepts only allowlisted redirect URIs of reviewed clients.
 * - Honeycomb: no official page for a remote server we could confirm.
 * - Mixpanel: the documented endpoint and auth conflict with what the server answers.
 * - Airtable: no official remote MCP server.
 * - Monday: the documented endpoint and auth conflict with what the server answers.
 * - Netlify: no official remote server page (its server runs locally).
 * - PagerDuty: no official page for a remote server we could confirm.
 * - Square: allowlisted redirect URIs only.
 * - Shopify: per-store (per-account) URL.
 * - Salesforce: per-org (per-account) URL and allowlisted connected apps.
 * - Snowflake: per-account URL.
 * - Databricks: per-workspace (per-account) URL.
 * - Microsoft 365: no official remote MCP server for mail and files.
 */

export function connectorById(id: string): ConnectorDef | undefined {
  return typeof id === 'string' ? CONNECTORS.find((c) => c.id === id) : undefined
}

/** The named variant, else the default one. */
export function connectorVariant(def: ConnectorDef, variantId?: string): ConnectorVariant {
  return def.variants.find((v) => v.id === variantId) ?? def.variants.find((v) => v.id === def.defaultVariant) ?? def.variants[0]
}

/**
 * Easiest first, for sorting: no sign-in at all, then one-click OAuth sign-in (dynamic client registration), then
 * a pasted token, then an OAuth app the user registers in the vendor's console.
 */
export const EASE_ORDER: readonly ConnectorEase[] = ['none', 'signIn', 'token', 'ownApp']

/** How much work connecting a variant takes (the named variant, else the default one, which is the easiest). */
export function connectorEase(def: ConnectorDef, variantId?: string): ConnectorEase {
  switch (connectorVariant(def, variantId).auth.kind) {
    case 'none':
      return 'none'
    case 'oauth':
      return 'signIn'
    case 'token':
      return 'token'
    case 'oauthClient':
      return 'ownApp'
  }
}

/** Position in EASE_ORDER (0 = easiest); sort by it. */
export function easeRank(ease: ConnectorEase): number {
  return EASE_ORDER.indexOf(ease)
}

/**
 * Gallery search: every whitespace-separated word of the query (case-insensitive) appears in the connector's name,
 * vendor, description, category or aliases. An empty query matches everything.
 */
export function connectorMatches(def: ConnectorDef, query: string): boolean {
  const words = (typeof query === 'string' ? query : '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [def.name, def.vendor, def.description, def.category, ...(def.aliases ?? [])].join('\n').toLowerCase()
  return words.every((w) => hay.includes(w))
}
