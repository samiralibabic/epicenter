# Chaining Is for Dependencies; Arrays Are for Peers

Method chaining shines when each step depends on the last: Express middleware, Promise chains, Knex query builders. The chain *is* the program, because order is the semantics. But when the things you're composing don't depend on each other, chaining hides your config from every tool that wants to read it. The trade is permanent for a one-time ergonomic win.

We hit this question last week deciding how operators configure Epicenter Server. Each operator picks some Cloud Apps (Ark, Billing, Dashboard) and mounts them at hosts. Two options:

```ts
// Option A: chained
createEpicenterServer('https://epicenter.so')
  .mount(arkApp,       { host: 'ark.epicenter.so' })
  .mount(billingApp,   { host: 'billing.epicenter.so' })
  .mount(dashboardApp, { host: 'dashboard.epicenter.so' });

// Option B: object
createEpicenterServer({
  origin: 'https://epicenter.so',
  apps: [
    defineArk({       host: 'ark.epicenter.so' }),
    defineBilling({   host: 'billing.epicenter.so' }),
    defineDashboard({ host: 'dashboard.epicenter.so' }),
  ],
});
```

Option A is one fewer level of nesting. Reads like an instruction list. Fine in isolation. We picked B anyway, and the reason generalizes past Epicenter.

## You can't read a procedure

The CLI that reads `epicenter.config.ts` to generate database migrations needs to know which Cloud Apps are mounted and what schemas they own. With the object form, that's a property of the config:

```ts
const config = await import('./epicenter.config.ts');
for (const app of config.default.apps) {
  console.log(app.id, app.migrations);
}
```

With the chained form, there is no `apps` property on the config. There's a builder that, when run, produces a server with private state. To see what's mounted you have to instantiate the server and ask it. The CLI is no longer reading config; it's running it.

The same friction shows up in the dashboard. "What's mounted on this server?" is a question with an obvious answer when the config is data, and a tooling problem when it's a procedure.

Conditional composition is where I felt it most:

```ts
apps: [
  defineArk({ host: 'ark.epicenter.so' }),
  ...(env.ENABLE_BILLING ? [defineBilling({ host: 'billing.epicenter.so' })] : []),
]
```

A spread guarded by a flag. Two lines. The chained version needs an if statement that forks the builder, or a `.maybeMount()` that ignores `undefined`, or some other compromise to keep the chain unbroken.

## The pattern is everywhere once you look

Vite plugins go in `plugins: []`. Better Auth plugins go in `plugins: []`. TanStack Router routes are an importable tree of objects. Hardhat networks are an object map. None of these care which entry comes first; they're all data.

Things that *do* chain share a property: each step depends on the output of the previous. Express `app.use(cors()).use(auth()).use(routes)` chains because the order is the semantics; flipping `auth` before `cors` is a different program. Promise `.then(a).then(b)` chains because `b` receives whatever `a` returned. Knex `.select().from().where().orderBy()` chains because each method narrows or transforms the query produced by the last.

Hono is the cleanest example of this split inside one library. Routes chain (`.get().post().route()`) because position determines precedence. Middleware chains because order is the matching rule. But plugins, when Hono accepts them, come as values.

Cloud Apps in Epicenter behave like Vite plugins, not like Express middleware. Ark doesn't depend on Billing being mounted first. Mounting Dashboard doesn't change what Ark needs. They share a server but nothing else. Independent peers go in an array.

## When chaining is right, it's really right

I want to be honest about this. Chaining for dependent operations is one of the best APIs you can ship. RxJS pipelines, Knex queries, Promise chains, Hono routes: the chain reads top to bottom and that's the program. You can't pull a `.then` out of the middle without changing the meaning. The ordering is the value the API delivers.

```ts
// chaining earns its keep when order is semantics
db('users')
  .select('id', 'email')
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(10);
```

Try writing that as an object. You'd end up with `{ select, where, orderBy, limit }` and you'd have to invent rules about evaluation order. The chain is doing real work.

The test:

```txt
Do later steps depend on earlier steps?

Yes:
  chain. Order is the semantics. The chain IS the program.
  Examples: middleware, streams, promises, query builders, route precedence.

No:
  array of values. Items are peers. Order is just typing order.
  Examples: plugins, routes-as-data, mounted apps, providers.
```

If you reach for chaining when the items are peers, you trade introspectability for nesting. The cost is permanent. Every tool that wants to read your config has to run it first.

## What we ship

Each Cloud App package exports its own factory function:

```ts
// inside @epicenter/ark
export function defineArk(config: { host: string; name?: string }) {
  return defineCloudApp({
    id: 'ark',
    host: config.host,
    name: config.name,
    scopes: ['ark:read', 'ark:publish'],
    routes: arkRoutes,
    schema: arkSchema,
    migrations: arkMigrations,
    policy: arkPolicy,
  });
}
```

The operator's config file imports those factories and lists them:

```ts
import { createEpicenterServer } from '@epicenter/server';
import { defineArk } from '@epicenter/ark';
import { defineBilling } from '@epicenter/billing';

export default createEpicenterServer({
  origin: 'https://epicenter.so',
  apps: [
    defineArk({ host: 'ark.epicenter.so' }),
    defineBilling({
      host: 'billing.epicenter.so',
      stripeKeyEnv: 'STRIPE_KEY',
      defaultPlan: 'free',
    }),
  ],
});
```

The server's only job is to take that array, validate the cross-cutting invariants (no duplicate hosts, no host collides with the origin), and dispatch. There is no `mount()`, no `.with()`, no internal builder state. The default export of `epicenter.config.ts` is a plain object you can read with `import` and walk like any other tree.

The day we ship something whose semantics actually depend on order, we'll chain there. For composing independent apps into one server, the array is the right primitive, because the apps are peers.
