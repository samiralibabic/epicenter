# CLI naming: why `up` / `down` / `ps` / `logs`

**Status**: decision recorded. Names already shipped; this doc captures the
reasoning so we don't relitigate it next time someone proposes `serve`.

## The question

The CLI's daemon-lifecycle verbs are `up`, `down`, `ps`, `logs`. Periodically
someone proposes renaming `up` to `serve` on the grounds that:

1. The daemon is foreground-by-design (Invariant 5: no `--detach`), so
   `Ctrl+C` is the natural lifecycle. `serve` matches that shape.
2. `serve` is widely recognized from Vite, Next, Wrangler, `php artisan serve`.
3. Without `--detach`, a paired `down` feels redundant.

This doc explains why we picked `up` anyway, grounds the choice against
real precedent, and records the rules of thumb for future verbs.

## What the daemon actually is

```
epicenter up --dir <path>
  |- loads epicenter.config.ts
  |- connects every workspace to the relay (WebSocket out)
  |- binds a per-`--dir` Unix socket for sibling CLI calls
  |- stays in foreground; SIGINT/SIGTERM tears it down
  `- no public HTTP listener, no port, no detach flag
```

It is **a peer joining a sync mesh**. Not a public web server. Not a service.
Not a stack of services. The daemon does expose internal Hono routes over a
Unix socket, but that socket is a control surface for sibling CLI commands
(`peers`, `list`, `run`), not a public HTTP API.

## The naming question is semantic, not lifecycle

The `serve` argument leans on lifecycle (foreground, Ctrl+C). But verb choice
is about what the thing **is**, not how its process exits. Three categories:

```
serve     "I host app requests"      vite, next dev, php artisan serve, syncthing
start     "I'm a managed service"    systemctl, pm2, docker container
up        "I'm joining a network"    tailscale up, wg-quick up, ifconfig up,
                                     docker compose up, vagrant up
```

Epicenter's daemon belongs in the third bucket. The closest semantic analog
is **Tailscale**:

| Tailscale            | Epicenter           |
| -------------------- | ------------------- |
| `tailscale up`       | `epicenter up`      |
| `tailscale down`     | `epicenter down`    |
| `tailscale status`   | `epicenter ps`      |
| `tailscale logs`     | `epicenter logs`    |

Both are foreground-capable peers that join a mesh and offer a local control
surface. Tailscale picked `up`. So did Wireguard (`wg-quick up`). So did
`ifconfig` and `ip link set ... up` going back to early Unix. The
peer-joins-network semantic owns `up`.

## Grounding against precedent

| Project              | Verb            | Public listener?  | Why that verb         |
| -------------------- | --------------- | ----------------- | --------------------- |
| Syncthing            | `serve`         | yes (REST + GUI)  | hosts app requests    |
| Vite, Next, Wrangler | `dev`           | yes               | dev server            |
| `php artisan`        | `serve`         | yes               | dev HTTP server       |
| Caddy                | `run` or `start`| yes               | hosts requests        |
| docker compose       | `up` / `down`   | n/a (orchestrator)| brings stack online   |
| Vagrant              | `up` / `halt`   | n/a               | brings VM online      |
| Tailscale            | `up` / `down`   | local API only    | peer joins tailnet    |
| Wireguard            | `up` / `down`   | none              | interface up          |
| redis-server, etcd   | (no verb)       | RPC               | program-name-as-verb  |
| Epicenter            | `up` / `down`   | **none**          | peer joins relay mesh |

The pattern: `serve` usually shows up where the primary job is hosting app
requests or a dev server. `up`/`down` shows up where you're bringing a peer
or environment online. Epicenter has internal HTTP-shaped routes over a Unix
socket, but no public listener and no user-facing web server. `serve` would
put attention on the transport instead of the peer joining the mesh.

## Why `down` earns its keep without `--detach`

Without backgrounding, the obvious teardown is `Ctrl+C`. So why have `down`?

1. **`--all`**: one daemon per `--dir`, so a developer can have several
   running across projects. `Ctrl+C` only kills the one in this terminal.
   `down --all` parallel-shuts the fleet.
2. **Out-of-band kill**: you backgrounded with `&` / `nohup` / `tmux` /
   `systemd --user`. There's no terminal to `Ctrl+C`.
3. **Graceful IPC shutdown**: `down` asks the daemon to release sockets and
   flush state cleanly (1s budget) before falling back to `SIGTERM`.

These are real cases. `serve` has no natural pair for them; `serve` + `stop`
would work but `stop` is generic and shows up next to `start`, which we
don't have and don't want.

## Why the family stays coherent

Five verbs. Each one syllable or two. Each pulls its weight:

```
up      bring this config online as a peer (foreground)
down    take it offline (--dir or --all)
ps      list running daemons (this user, this machine)
logs    tail the rotating log
peers   show CRDT peers of a workspace
```

`ps` and `logs` are compose-shaped verbs. They look natural next to `up`,
awkward next to `serve`. Renaming `up` to `serve` would force a cascade:
`serve` / `stop` / `status` / `logs`, and you'd end up less coherent than
where you started.

Reads better than nesting (`epicenter daemon start`, `epicenter daemon
stop`). Five top-level verbs is the right scale for a flat command set.

## The rules of thumb

When picking a verb for a new lifecycle command, in order:

1. **What is this thing semantically?** A request-handler? A managed
   service? A peer joining a network? Pick the verb category from the
   table above.
2. **Is its primary job hosting app requests or a public dev server?** If
   no, `serve` is probably wrong. If yes, `serve` is on the table.
3. **Can it run as a fleet?** If yes, you need a verb that pairs with a
   fleet-wide kill (`down --all`). `up`/`down` does this; `serve` doesn't.
4. **Does the family stay flat with one-syllable verbs?** Good. Resist
   noun-verb nesting (`epicenter daemon start`) until the verb count
   makes flat unworkable.

## Tweaks worth considering (not blocking)

- **`ps` -> `status`**. `status` is what Tailscale uses and it's clearer
  for first-time readers. `ps` is short and unix-savvy. Either is fine;
  not worth a rename until something else forces a CLI version bump.
- **`run` -> `call` or `invoke`**. The current `run` (action invocation)
  collides mentally with "run a server." `call notes.add` reads more
  like an RPC, which is what it is.
- **`list` -> something concrete**. `list` is generic. If it lists table
  rows, `rows`. If it lists workspaces, `workspaces`. Pick the noun.
- **`auth` -> `login` / `logout`**. More concrete than `auth <subcommand>`.

These are all paint-the-bikeshed calls. The daemon-lifecycle naming is
settled.

## What we considered and rejected

**`serve`**: wrong semantic. It implies hosting a public app surface or dev
server. We have internal HTTP-shaped IPC over a Unix socket, but no public
listener. The closest analogs (Tailscale, Wireguard) explicitly chose `up`.
See spec `20260426T235000-cli-up-long-lived-peer.md` section "Naming".

**`start` / `stop`**: carries systemd / managed-service baggage. Implies
something else (init system, supervisor) is responsible for the process.
We're not that.

**`host`**: less semantic than `up`, less lifecycle-clear. Considered
in the original spec and rejected.

**`epicenter daemon start` (noun-verb nesting)**: overkill for a flat
five-verb surface. Reserve for when the command count forces the
hierarchy.

## Cross-references

- `specs/20260426T235000-cli-up-long-lived-peer.md`: original spec,
  including the Invariants that lock down "no `--detach`," "one daemon
  per `--dir`," "IPC protocol is internal."
- `packages/cli/src/commands/up.ts`: implementation.
- `packages/cli/src/commands/down.ts`: implementation, including the
  `--all` fleet shutdown path.
