# Asymmetric Wins: Support Fewer Features to Collapse Complexity

One of the most useful questions I ask when coding, especially greenfield work, is: is there an asymmetric win here?

Can we refuse 10 to 20 percent of functionality and delete 80 or 90 percent of the complexity? Sometimes the strongest invariant does not come from a better abstraction. It comes from refusing the feature that would have broken the rule.

The auth spec made this visible immediately:

```ts
// Before: two social sign-in shapes
auth.signInWithIdToken({ provider: 'google', idToken });
auth.signInWithSocial({ provider: 'github' });

// After: one social sign-in shape
auth.signInWithSocial({ provider });
```

The removed feature was not nonsense. A Google OIDC fast path would have made browser SPA sign-in faster. The question was whether that small feature earned the second shape it forced into the whole auth system.

That is the important part: the number is not a quota. You do not remove features at random and hope complexity falls out. You look for the one small promise that owns a whole implementation family, then ask whether refusing that promise leaves the product sentence intact.

## One small promise can own most of the graph

The earlier spec had a split social sign-in model:

```txt
Google in browser SPA
  -> GIS popup
  -> ID token
  -> signInWithIdToken

Non-OIDC provider, extension, Tauri, bearer SPA
  -> OAuth page
  -> PKCE
  -> signInWithSocial
```

That looks reasonable until you count what the fast path owns. It needs a method, a provider subset, a GIS helper, browser-blocked error handling, fallback UI, tests, docs, and a story for every future OIDC provider that does not use Google's SDK.

Refusing the fast path collapses the graph:

```txt
Any social provider, any app environment
  -> API-hosted OAuth page
  -> PKCE
  -> signInWithSocial
```

The product still has social sign-in. It just refuses to promise the special browser-only "Google is faster" feature.

## The feature-refusal question is sharper than the abstraction question

The normal engineering reflex is to ask how to make the two paths clean:

```txt
Can we derive OIDCProvider from Better Auth?
Can we put GIS in a shared Svelte helper?
Can we model SocialSignInUnavailable cleanly?
Can we make the redirect path and token path share errors?
```

Those are valid questions, but they all assume the second path deserves to exist. The better first question is:

```txt
Which supported behavior owns the most machinery?
Who would notice if we refused that behavior?
```

For Epicenter, the answer was weak. Users sign in once and stay signed in for months. The fast path saves a few seconds per sign-in, mostly for browser SPAs, and does not help the Chrome extension or future Tauri app much. Full OAuth redirects are normal in dev tools. Users are usually okay with redirects.

So the strongest move was not "abstract GIS better." It was "do not ship GIS."

## An asymmetric win has a specific shape

This is the pattern I want to keep catching:

```txt
Small feature:
  A nicer path for one provider, runtime, import shape, config format, or old caller.

Code it forces:
  A second method, adapter, union, fallback, error variant, docs branch, and test family.

Refusal:
  One canonical path remains.

Payoff:
  The product sentence gets shorter and the invariant gets stronger.
```

This is not minimalism for its own sake. It is a code-complexity trade. If refusing a small feature makes the system less useful in a load-bearing way, keep the feature and own the complexity. But if the feature is a convenience for one edge while the cost is a permanent second shape, refuse it.

The auth case passed that test:

| Refused feature | Code that disappears |
|---|---|
| Browser SPA Google GIS fast path | `signInWithIdToken` |
| OIDC-only social method | `OIDCProvider` narrowing |
| Provider-specific browser helper | `getGoogleIdToken()` and package export |
| GIS blocked-browser handling | `SocialSignInUnavailable` and fallback UI |
| Fast path plus fallback story | two social sign-in docs and test paths |

That is the kind of deletion that changes the architecture, not just the line count.

## AI makes this more important, not less

AI makes it easy to generate the second path. It can write the helper, the error union, the fallback, the adapter package, and the tests before the smell has time to feel expensive. That makes feature refusal more important, because the cost does not show up as typing effort anymore. It shows up later as a permanent invariant.

The checkpoint belongs before implementation:

```txt
Which small promise carries the biggest implementation graph?
Can we refuse that promise outright?
Does refusing it delete a whole family of code?
Would the product sentence still be true?
```

If yes, the clean break is not "make both paths cohesive." The clean break is to delete one path from the design before it exists.

For auth, the final sentence became:

```txt
All social sign-in routes through the API-hosted page via OAuth 2.1 PKCE.
```

No fast path. No provider-specific client method. No "or." That is the invariant.
