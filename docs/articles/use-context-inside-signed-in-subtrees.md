# Use Context Inside Signed-In Subtrees

Current workspace-backed apps do not use context for the signed-in workspace
handle. Fuji, Honeycrisp, and Zhongwen use `createSession`, gate on
`session.current`, and expose a module-level `getSignedInSession()` helper from
`session.svelte.ts`. This article is about the narrower identity-only case:
when a subtree needs an ambient authenticated identity and does not own a
workspace lifecycle.

For Svelte descendants, I like context better than prop drilling once you are inside a protected or signed-in subtree. The route gate already proved the user is signed in. Past that point, making every child accept `identity` as a prop or write `auth.identity?.user` is just making the rest of the tree re-prove something the parent already knows.

The common version looks like this:

```svelte
<!-- +layout.svelte -->
{#if auth.state.status === 'pending'}
  <Loading />
{:else if auth.state.status === 'signed-in'}
  {@render children()}
{:else}
  <SignIn />
{/if}
```

That `{#if}` is doing real work. It creates a signed-in subtree.

```text
+layout.svelte
`-- auth.state.status === 'signed-in'
    |-- Dashboard.svelte
    |-- AccountMenu.svelte
    |-- WorkspaceList.svelte
    `-- SettingsPage.svelte
```

Every component under that branch is born into the same fact: there is an `AuthIdentity`. So the code inside the branch should get to feel that way.

Without context, the identity leaks through every layer.

```svelte
<!-- +layout.svelte -->
{#if auth.state.status === 'signed-in'}
  <Dashboard identity={auth.state.identity} />
{/if}
```

```svelte
<!-- Dashboard.svelte -->
<AccountMenu {identity} />
<WorkspaceList {identity} />
```

```svelte
<!-- AccountMenu.svelte -->
<p>{identity.user.name}</p>
```

That works, but `Dashboard` does not care about auth. It only accepts `identity` so it can hand it to something else. Add a few more intermediate components and now auth has become plumbing.

The other common version is worse because every component keeps asking if the user exists.

```svelte
<script lang="ts">
  import { auth } from '$lib/auth';
</script>

{#if auth.state.status === 'signed-in'}
  <p>{auth.state.identity.user.name}</p>
{/if}
```

This is fine at the gate. It gets noisy deeper in the tree. Once a component only exists inside the signed-in branch, the null check is not adding safety. It is repeating the gate.

Context lets the parent say the fact once.

```ts
// auth-identity-context.ts
import { createContext } from 'svelte';
import type { AuthClient, AuthIdentity } from '@epicenter/auth';

export class AuthIdentityContext {
  constructor(private auth: AuthClient) {}

  get identity(): AuthIdentity {
    if (this.auth.state.status !== 'signed-in') {
      throw new Error('Auth identity is only available inside a signed-in subtree');
    }

    return this.auth.state.identity;
  }

  get user() {
    return this.identity.user;
  }
}

export const [getAuthIdentityContext, setAuthIdentityContext] =
  createContext<AuthIdentityContext>();
```

The layout registers the context once, during component initialization.

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { auth } from '$lib/auth';
  import { setAuthIdentityContext, AuthIdentityContext } from '$lib/auth-identity-context';

  setAuthIdentityContext(new AuthIdentityContext(auth));
</script>

{#if auth.state.status === 'pending'}
  <Loading />
{:else if auth.state.status === 'signed-in'}
  {@render children()}
{:else}
  <SignIn />
{/if}
```

Then descendants read the identity directly.

```svelte
<!-- AccountMenu.svelte -->
<script lang="ts">
  import { getAuthIdentityContext } from '$lib/auth-identity-context';

  const authIdentity = getAuthIdentityContext();
</script>

<p>{authIdentity.user.name}</p>
```

The important part is that the context holds a handle, not a one-time identity value. The getter reads `auth.state` each time, so it stays current when the auth state changes. The signed-in branch still controls whether descendants render.

```text
auth.state
   |
   |-- +layout.svelte decides which branch exists
   |
   `-- AuthIdentityContext reads the current signed-in identity
        |
        |-- AccountMenu.svelte
        |-- WorkspaceList.svelte
        `-- SettingsPage.svelte
```

There is one Svelte rule to respect: call `setContext` during component initialization, not inside `$effect`. If the identity can change later, do not try to call `setContext` again. Put a reactive getter in context instead.

This is the line I use for deciding when the pattern fits: if the parent has already gated the component tree, children should not have to prove the gate again.

Use props when a parent is configuring a child. Use context when a whole subtree shares an ambient fact. Signed-in identity is an ambient fact inside a protected route.
