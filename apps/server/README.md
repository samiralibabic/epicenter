# Epicenter Server

Epicenter Server is the self-hostable auth and sync runtime.

It owns account cookies, OAuth token issuance, workspace identity, encryption
key derivation, workspace sync, and document sync. It must stay useful without
Postgres.

```txt
Domains split by public protocol role.
Deployables split by infrastructure and operational boundary.
Hono modules split by code composition boundary.
```

In hosted production, this deployable serves two public roles:

```txt
accounts.epicenter.so
  account pages
  OAuth issuer metadata
  authorize, token, revoke, JWKS
  sign-in and consent

sync.epicenter.so
  protected resource metadata
  /me
  workspace sync
  document sync
```

Self-hosters can run the same server on one origin:

```txt
https://server.example.com
|-- account and OAuth routes
|-- /me
`-- /rooms/*
```

Composition happens in the deployable root:

```txt
createServerApp()
|-- createAccountsRoutes(serverEnv)
|-- createSyncRoutes(serverEnv)
`-- createHostDispatch()
    |-- accounts.epicenter.so -> accounts routes
    |-- sync.epicenter.so -> sync routes
    `-- self-hosted default -> accounts routes + sync routes
```

The route modules receive dependencies from `app.ts`. They should not import the
deployable root, import sibling modules, or reach into Cloud code.

```txt
ServerEnv
|-- auth
|   |-- Better Auth instance
|   |-- oauthProvider
|   `-- trusted clients
|-- identity
|   |-- user lookup
|   `-- encryption key derivation
|-- sync
|   |-- workspace store
|   |-- document store
|   `-- websocket rooms
`-- config
    |-- issuer origins
    |-- resource origins
    `-- self-hosted origin
```

Allowed dependencies:

```txt
apps/server
|-- Better Auth
|-- OAuth token issuing and JWKS
|-- self-hostable storage
|-- workspace sync
|-- document sync
|-- encryption key derivation
`-- packages/auth shared types
```

Forbidden dependencies:

```txt
apps/server
|-- Drizzle Postgres bindings
|-- billing provider SDKs
|-- hosted storage registry
|-- Cloud dashboard source
`-- proprietary Cloud control-plane code
```

The future split should be boring. If accounts and sync ever need independent
deployment, `apps/accounts` can mount `createAccountsRoutes()` and `apps/sync`
can mount `createSyncRoutes()` without rewriting the route modules.
