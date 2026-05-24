# Tool Names Are Identifiers, Not Paths

`tabs.close` feels like the obvious name until the model provider rejects it. Then you rename it to `tabs_close`, wonder why everyone is so fussy about punctuation, and start asking whether the underscore is really load-bearing.

It is. Not because underscores are elegant. Because tool names live in the worst possible intersection of systems: JSON, schemas, SDKs, logs, model sampling, client stubs, MCP bridges, and code-trained LLMs. In that intersection, a dot is not just a dot.

```txt
tabs.close
  Looks like: namespace.member
  Reads like: call close on tabs
  Breaks like: one string pretending to be a path

tabs_close
  Looks like: one identifier
  Reads like: one callable tool
  Breaks like: mostly nowhere
```

The providers are not banning hierarchy. They are treating tool names as portable identifiers. That is the right instinct.

## The portable floor is smaller than the specs suggest

OpenAI function names allow letters, numbers, underscores, and dashes, up to 64 characters. Anthropic client tools use the same practical shape with a regex: `^[a-zA-Z0-9_-]{1,64}$`. Gemini recommends descriptive names without spaces or special characters, using underscores or camelCase.

MCP is more permissive. Its draft tool-name guidance allows letters, digits, underscore, hyphen, and dot:

```txt
getUser
DATA_EXPORT_v2
admin.tools.list
```

That does not make dots portable. It means MCP can describe names that the major model APIs may reject. When your tool might cross provider boundaries, the real contract is the strictest common subset, not the widest spec.

I would use this:

```txt
^[a-z][a-z0-9_]{0,63}$
```

Lowercase. Numbers after the first character. Underscores for separation. No dots. No dashes. No capitals.

This is stricter than OpenAI and Anthropic require, but stricter in the useful direction. It gives you one naming rule that survives APIs, generated clients, shell commands, logs, eval datasets, and human review.

## A dotted name is always doing two jobs

The problem with `tabs.close` is not that the character is invalid in JSON. JSON object keys can be almost anything. The problem is that downstream systems rarely treat names as inert strings forever.

They turn names into paths:

```txt
tools.tabs.close.input.url
```

Now the question is ambiguous:

```txt
tools
  tabs
    close
      input
        url
```

Or:

```txt
tools
  "tabs.close"
    input
      url
```

JSONPath and JMESPath both have dot notation. Logs often use dotted fields. Config systems use dotted paths. Error messages use dotted paths. Client generators want field names they can emit without quoting.

If a name is a valid identifier, every layer can treat it as a bare name:

```ts
tools.tabs_close.input.url
```

If it contains a dot, someone has to remember to quote it:

```ts
tools["tabs.close"].input.url
```

That quoting rule will be forgotten somewhere. Tool names should not depend on everyone remembering the special case.

## The model also sees the dot as structure

LLMs do not call tools by executing JavaScript, but they learned the shape of calls from code. In most code, `tabs.close` is member access. The left side is an object. The right side is a property or method.

So when the model sees this:

```json
{ "name": "tabs.close" }
```

It is seeing a string, but it is also seeing a pattern that looks like code. That matters because tool calling is a generation problem. The model has to emit the exact name, and `tabs.close` gives it an extra boundary where it can drift.

The common examples all point the other way:

```txt
get_weather
search_docs
read_file
set_light_values
```

`snake_case` is not magic. It is just the convention the model has seen over and over for function-like names.

## Prefixes are enough hierarchy for a flat action bag

If your actions are a flat record, let them be flat. Do not keep a dot around to cosplay as a nested object.

```ts
const actions = {
  tabs_close: defineMutation(...),
  tabs_list: defineQuery(...),
  tabs_focus: defineMutation(...),
  files_read: defineQuery(...),
  files_write: defineMutation(...),
  workspace_search: defineQuery(...),
};
```

The prefix is the hierarchy. The underscore is the separator.

When you need a grouped view, derive one explicitly:

```txt
tabs
  close
  list
  focus

files
  read
  write

workspace
  search
```

That is better than making the canonical name carry two meanings. `tabs_close` is the actual name. `tabs` is a display grouping, a filter prefix, or a documentation section.

The one real loss is scannability. Dots make a long list look like two columns:

```txt
tabs.close
tabs.list
files.read
files.write
workspace.search
```

Snake case is more compact but less visually structured:

```txt
tabs_close
tabs_list
files_read
files_write
workspace_search
```

That is a UI problem, not a naming problem. Group the list in the UI. Do not leak path syntax into the identifier.

## Boundary translation is a tax

You can keep canonical dotted action names and translate only at the AI boundary:

```txt
Canonical action: tabs.close
AI tool name:     tabs_close
```

That looks tidy at first. It keeps the human-facing action name pretty while satisfying provider regexes.

But now the system has two names for one thing:

```ts
type ToolName = DotsToUnderscores<ActionName>;

const toolName = actionName.replaceAll(".", "_");
const actionName = toolName.replaceAll("_", ".");
```

That translation brings rules with it. Maybe action names cannot contain underscores anymore. Maybe tool names need reverse mapping. Maybe logs need both names. Maybe evals see one name and runtime errors show another. Maybe MCP allows a dot but Claude or OpenAI rejects it.

None of that complexity buys you a capability. It buys you punctuation.

The clean version is boring:

```txt
Authoring name: tabs_close
CLI name:       tabs_close
RPC name:       tabs_close
AI tool name:   tabs_close
Log field:      tabs_close
```

One name. No projection. No adapter. No question about which name an error message should show.

## The rule I would ship

For model-facing tools and action registries, use lowercase `snake_case` as the canonical name:

```txt
good:
  tabs_close
  saved_tabs_restore
  files_read
  workspace_search

bad:
  tabs.close
  tabs-close
  tabsClose
  Tabs_Close
```

Allow hierarchy through prefixes:

```txt
<domain>_<action>
<domain>_<object>_<action>
```

Examples:

```txt
tabs_close
tabs_close_all
saved_tabs_restore
workspace_member_invite
workspace_member_remove
```

The separator does not need to encode the full tree. If the hierarchy becomes deep enough that names get hard to read, the fix is not punctuation. The fix is fewer tools, clearer domains, or explicit metadata:

```ts
{
  name: "workspace_member_invite",
  group: "workspace",
  title: "Invite workspace member",
}
```

Tool names should be optimized for exact calling. Titles, groups, docs, and UI can carry the human presentation.

## The dot is a nice authoring illusion and a bad wire contract

Dots are great when the thing is actually a path. They are great for package names, object access, namespaces, and nested configuration.

A tool name is different. It is a callable identifier that has to survive model generation and a pile of boring infrastructure. The more it looks like a plain identifier, the fewer systems have to special-case it.

So yes, `tabs.close` reads nicely. But `tabs_close` is the name I would ship.

Not because underscores are beautiful. Because the boring name is the portable one.

## Sources

- [OpenAI API reference](https://platform.openai.com/docs/api-reference): function names must use letters, numbers, underscores, or dashes, with a 64 character limit.
- [Anthropic tool use docs](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use): tool names must match `^[a-zA-Z0-9_-]{1,64}$`.
- [Gemini function calling docs](https://ai.google.dev/gemini-api/docs/function-calling): function names should avoid spaces and special characters, using underscores or camelCase.
- [MCP tool names](https://modelcontextprotocol.io/specification/draft/server/tools): MCP allows letters, digits, underscore, hyphen, and dot, which is broader than the major model API floor.
- [JSONPath RFC 9535](https://www.ietf.org/rfc/rfc9535.html) and [JMESPath](https://jmespath.org/specification.html): dot notation and identifier rules explain why dotted keys stop being inert strings downstream.
