# Clean-Break Evaluation Prompt: Auth Token Capability Boundary

Use this prompt after reading `specs/20260512T114350-auth-token-capability-boundary.md`. The goal is to evaluate whether the spec is coherent enough to execute as a clean break.

```txt
You are reviewing an Epicenter auth architecture spec for clean-break quality.

Repo: /Users/braden/Code/epicenter
Spec: specs/20260512T114350-auth-token-capability-boundary.md

Core thesis:
Epicenter auth stores token credentials privately and exposes only identity and transport capabilities to app code.

Product constraint:
Do not propose cookie-first app auth, a backend frontend token mediator, or per-app auth modes. Epicenter is intentionally token-native across browser apps, extensions, Tauri, CLI, daemons, HTTP, and WebSocket sync.

Your task:
Evaluate the spec, not the implementation. Read the spec and the current local code it references. Then produce a clean-break review with findings first.

Required local files to inspect:
- packages/auth/src/auth-types.ts
- packages/auth/src/create-oauth-app-auth.ts
- packages/auth/src/auth-contract.ts
- packages/auth-svelte/src/create-auth.svelte.ts
- packages/svelte-utils/src/session.svelte.ts
- apps/tab-manager/src/lib/platform/auth/auth.ts
- at least one browser app platform auth file, for example apps/opensidian/src/lib/platform/auth/auth.ts
- apps/api/src/auth/single-credential.ts
- packages/sync/src/auth-subprotocol.ts

Apply these lenses:

1. One-sentence test
   - Can every proposed surface be explained by the thesis?
   - Does any section require saying "or" to describe the new API?

2. Ownership test
   - Does one layer own identity?
   - Does one layer own network credentials?
   - Does one layer own transport auth?
   - Are refresh tokens ever owned by sync, chat, UI, or workspace code?

3. Hybrid API test
   - Does the spec leave both `sessionStorage` and `sessionStore` alive?
   - Does it leave old flat `OAuthSession` and new nested `OAuthSession` as accepted app-facing shapes?
   - Does it leave compatibility aliases without proving they are a product requirement?

4. Asymmetric wins pass
   - Which small convenience forces the largest code family?
   - Would refusing it preserve the product sentence?
   - If yes, recommend refusing it.

5. Build, Prove, Remove ordering
   - Does the plan build the new path first?
   - Does it stop importing the old path before deleting it?
   - Does it require verification before deletion?

6. Runtime safety
   - Does the spec keep long-running sync working through `auth.openWebSocket()`?
   - Does it keep refresh tokens hidden while still usable by auth?
   - Does it make storage backend choice explicit?
   - Does it preserve local identity during network reauth failure?

Output format:

Findings first, ordered by severity.

Use this shape:

P0/P1/P2: Short title
File or spec section:
Problem:
Why it matters:
Recommendation:

Then include:
- Clean-break verdict: Ship / revise / reject
- The best one-sentence version of the spec after your review
- Any old vocabulary that must be deleted before implementation is complete
- Any evidence questions that must be verified before coding

MUST NOT:
- Do not propose raw token getters.
- Do not propose app-owned Authorization header construction.
- Do not propose cookie-first app auth or backend frontend mediation.
- Do not preserve old and new config names unless you identify a concrete shipped compatibility requirement.
- Do not implement code.
- Do not produce a prose-only review. Use concrete file paths, code names, and spec sections.
```
