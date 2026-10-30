import type { ConnectorDef, ConnectorOAuthOverrides, ConnectorVariant } from './types'

/**
 * The connector catalog: curated presets for official remote MCP servers of outside services. Pure data,
 * structured-clone safe; connectors:add (src/main/mcp/connectors.ts) turns a preset into an app-wide MCP library
 * entry. Nothing here was tested against the live services (every `verified` is false): URLs, scopes and setup
 * steps come from the vendors' docs as of late 2026.
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

const googleSetup = (api: string): string[] => [
  'In the Google Cloud console, create (or pick) a project.',
  `Enable the ${api} and its MCP server for that project.`,
  'Configure the OAuth consent screen; while it is in Testing, add your Google account as a test user.',
  'Create an OAuth client of type "Web application".',
  `Add ${CONNECTOR_REDIRECT_URI} as an authorized redirect URI.`,
  'Paste the client id and client secret into OrgAI, then Authorize.'
]

const GOOGLE_NOTES = [
  'Google lists its MCP servers as a Developer Preview.',
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
  docsUrl: string
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
  notes: GOOGLE_NOTES,
  verified: false
})

const dcrSetup = (service: string): string[] => [
  `Add the connector, then Authorize: your browser opens ${service}'s sign-in page.`,
  'Approve access, then return to OrgAI.',
  'Link it to a project and grant it to the roles that need it.'
]

export const CONNECTORS: readonly ConnectorDef[] = [
  google(
    'gmail',
    'Gmail',
    'email',
    'Search and read your Gmail messages and threads.',
    'https://gmailmcp.googleapis.com/mcp/v1',
    'Gmail API',
    ['https://www.googleapis.com/auth/gmail.readonly'],
    'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server'
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
    'https://docs.cloud.google.com/mcp/overview'
  ),
  google(
    'google-drive',
    'Google Drive',
    'files',
    'Search and read files in your Google Drive.',
    'https://drivemcp.googleapis.com/mcp/v1',
    'Google Drive API',
    ['https://www.googleapis.com/auth/drive.readonly'],
    'https://docs.cloud.google.com/mcp/overview'
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
      'At api.slack.com/apps, create a Slack app for your workspace.',
      `Under OAuth & Permissions, add the redirect URL ${CONNECTOR_REDIRECT_URI} and the user scopes the MCP server needs.`,
      'Have a workspace admin approve the app if your workspace requires it.',
      'Paste the app\'s client id and client secret into OrgAI, then Authorize.'
    ],
    notes: [
      'The server includes write tools (sending messages); grant it only to roles that should act in Slack.',
      'Slack documents that redirect URLs must use HTTPS, so it may refuse OrgAI\'s http loopback redirect. Unverified.',
      'Unverified: the token response shape of oauth.v2.user.access and which scopes the server expects (OrgAI uses the scopes Slack\'s discovery metadata lists).'
    ],
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
    notes: ['The server includes write tools (creating and editing pages).', 'Unverified: dynamic client registration with a loopback redirect.'],
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
        auth: {
          kind: 'token',
          header: 'Authorization',
          prefix: 'Bearer ',
          label: 'Personal access token',
          help: 'A fine-grained token with read access to the repositories agents should see.',
          link: 'https://github.com/settings/personal-access-tokens/new'
        }
      },
      {
        id: 'full',
        label: 'Full access',
        description: 'Read and write tools; the token\'s permissions still apply.',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        readOnly: false,
        auth: {
          kind: 'token',
          header: 'Authorization',
          prefix: 'Bearer ',
          label: 'Personal access token',
          help: 'A fine-grained token with the repository permissions agents need.',
          link: 'https://github.com/settings/personal-access-tokens/new'
        }
      }
    ],
    defaultVariant: 'readonly',
    setup: ['Create a fine-grained personal access token on GitHub.', 'Paste it into OrgAI and test the connection.'],
    notes: ['The token is stored with Electron safeStorage and sent as Authorization: Bearer.'],
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
        label: 'Restricted API key',
        description: 'The key\'s permissions decide what agents can do; a read-only key keeps it read-only.',
        transport: 'http',
        url: 'https://mcp.stripe.com',
        readOnly: false,
        auth: {
          kind: 'token',
          header: 'Authorization',
          prefix: 'Bearer ',
          label: 'Restricted API key',
          help: 'A restricted key (rk_...) with only the read permissions agents need.',
          link: 'https://dashboard.stripe.com/apikeys'
        }
      }
    ],
    defaultVariant: 'oauth',
    setup: dcrSetup('Stripe'),
    notes: ['The server includes write tools (creating customers, refunds); prefer a restricted key with read permissions.'],
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
    notes: ['Unverified: that Figma\'s remote server accepts clients other than the ones it lists.'],
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
    verified: false
  }
]

export function connectorById(id: string): ConnectorDef | undefined {
  return typeof id === 'string' ? CONNECTORS.find((c) => c.id === id) : undefined
}

/** The named variant, else the default one. */
export function connectorVariant(def: ConnectorDef, variantId?: string): ConnectorVariant {
  return def.variants.find((v) => v.id === variantId) ?? def.variants.find((v) => v.id === def.defaultVariant) ?? def.variants[0]
}
