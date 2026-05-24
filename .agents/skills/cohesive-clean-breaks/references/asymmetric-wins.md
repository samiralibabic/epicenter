# Asymmetric Wins

An asymmetric win is a refusal that gives back more complexity than it costs in
product capability. The usual shape is: refuse 10-20 percent of functionality
and collapse 80-90 percent of the implementation graph.

Do not apply this as arithmetic. The agent's job is to find the specific small
promise that owns the large code family.

## Decision Template

```txt
Product sentence:
  ...

Candidate refusal:
  ...

Code family it deletes:
  ...

User loss:
  ...

Decision:
  Refuse it / keep it because ...
```

## Auth Example

Product sentence:

```txt
All social sign-in routes through the API-hosted page via OAuth 2.1 PKCE.
```

Candidate refusal:

```txt
Browser SPAs can use Google GIS for a roughly 1-second sign-in.
```

Code family it deletes:

```txt
signInWithIdToken
OIDCProvider narrowing
per-app GIS helpers
GIS blocked-browser UI
SocialSignInUnavailable
provider-specific SDK scaling for Apple and Microsoft
two social sign-in docs branches
two social sign-in test paths
```

User loss:

```txt
Google sign-in is a few seconds slower in browser SPAs.
```

Decision:

```txt
Refuse it. The UX loss is small; the second auth shape is permanent.
```

That is not less product in the way that matters. The product still has social
sign-in. It refuses one fast path so one invariant can own every provider and
environment.

For narrative context, see
`docs/articles/20260504T160541-asymmetric-wins-support-fewer-features-to-collapse-complexity.md`.
