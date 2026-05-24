# Epicenter Cloud

Epicenter Cloud is the hosted control plane.

It owns hosted-only state: billing, plan and entitlement checks, hosted storage
registry data, asset management, dashboard APIs, and the dashboard SPA. Postgres,
Drizzle, billing SDKs, and managed infrastructure are allowed here.

```txt
Domains split by public protocol role.
Deployables split by infrastructure and operational boundary.
Hono modules split by code composition boundary.
```

Cloud serves one hosted public role:

```txt
api.epicenter.so
|-- /.well-known/oauth-protected-resource
|-- /api/billing/*
|-- /api/storage/*
|-- /api/assets/*
`-- /dashboard/*
```

Cloud verifies OAuth access tokens issued by Epicenter Server. It does not own
sign-in, account cookies, workspace boot identity, or encryption key derivation.

Composition happens in the deployable root:

```txt
createCloudApp()
|-- createCloudResourceRoutes(cloudEnv)
|-- createDashboardRoutes(cloudEnv)
`-- mount
    |-- /.well-known/oauth-protected-resource -> cloud resource routes
    |-- /api/* -> cloud resource routes
    `-- /dashboard/* -> dashboard routes
```

The dashboard is a SvelteKit SPA owned by this app and served by the Cloud Hono
app:

```txt
apps/cloud/dashboard
  -> builds static SPA assets
  -> served at api.epicenter.so/dashboard/*
  -> signs in through accounts.epicenter.so
  -> receives tokens for api.epicenter.so
  -> calls api.epicenter.so/api/*
```

The route modules receive dependencies from `app.ts`. They should not import the
deployable root, import sibling modules, or reach into Server internals.

```txt
CloudEnv
|-- oauth
|   |-- issuer = accounts.epicenter.so
|   `-- resource = api.epicenter.so
|-- db
|   |-- Drizzle
|   `-- Postgres
|-- billing
|-- storageRegistry
|-- assets
|-- dashboardAssets
`-- config
    `-- cloud origin
```

Allowed dependencies:

```txt
apps/cloud
|-- packages/ui
|-- packages/auth shared types
|-- OAuth access-token verification
|-- Drizzle
|-- Postgres
|-- billing provider SDKs
|-- hosted storage registry
`-- asset management
```

Forbidden dependencies:

```txt
apps/cloud
|-- Better Auth raw Session as app auth
|-- Better Auth getSession() for protected resources
|-- encryption key derivation
|-- apps/server sync internals
`-- /me as workspace boot identity
```

Pricing, subscriptions, invoices, usage, and hosted storage controls belong
here. Account recovery, MFA, passkeys, consent, and OAuth token issuance belong
to Epicenter Server.
