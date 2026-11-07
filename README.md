# nexo

[![npm version](https://img.shields.io/npm/v/@hexdecimal16/nexo)](https://www.npmjs.com/package/@hexdecimal16/nexo)
[![test](https://github.com/hexdecimal16/nexo/actions/workflows/test.yml/badge.svg?event=push)](https://github.com/hexdecimal16/nexo/actions/workflows/test.yml)

nexo is an AI agent that runs on your machine. It tracks what each run costs, scores the results, and keeps every run inspectable. You can use it from the terminal, from a web run inspector, or from Node code.

Requires Node 22.19 or newer.

## Install

```sh
npm install -g @hexdecimal16/nexo
nexo init      # pick two models (s1, s2), store their API keys, make one test call
```

Running `nexo` for the first time also opens this setup. `nexo update` tells you when a newer version is out.

## Everyday use

```sh
nexo                                            # chat; type /settings to change anything
nexo run "summarize this folder" --budget 0.25  # one task, then exit
nexo ui                                         # run inspector: traces, costs, scores
nexo cost --by day                              # what you spent
nexo doctor                                     # check Node, config, keys and tools
```

`nexo --help` lists every command. Data lives in `~/.nexo`. Set `NEXO_HOME` to move it.

## Settings and keys

Every option is in `/settings` inside a chat, or in `nexo settings` from the shell:

```sh
nexo settings keys                       # which keys are set and where from (never the values)
nexo settings set-key anthropic          # hidden prompt, or pipe the key on stdin
nexo settings set budgets.perRunUsd 0.5
```

Keys are stored in `~/.nexo/credentials.json` (mode 600) and redacted from logs. A provider's environment variable, such as `ANTHROPIC_API_KEY`, takes precedence over the stored key.

## Optional tools

**Web search.** Set a [Brave Search](https://api-dashboard.search.brave.com) or [Tavily](https://app.tavily.com) key and the agent gets a `web_search` tool. With both keys, it queries both and merges the results.

```sh
nexo settings set-key brave              # or tavily
nexo search "node 22 release notes"      # try it without a model
```

**Browser control.** The agent can drive your own Chrome, with your signed-in sites, through [playwright-cli](https://github.com/microsoft/playwright-cli) and the Playwright Extension. It keeps page snapshots on disk and reads only the lines it needs, so browsing uses few tokens.

```sh
npm install -g @playwright/cli@latest
nexo settings set-key playwright-personal   # paste the token from the Playwright Extension in that Chrome profile
```

Add one key per Chrome profile, such as `playwright-work`. First-run setup and `/settings` offer the same step. The browser skill tells the agent to ask before sending, posting, buying or deleting anything. Its wrapper also blocks the commands that run arbitrary code in your pages.

## Use it from Node

```ts
import { createNexo } from "@hexdecimal16/nexo/sdk";

const nexo = createNexo();
try {
  const result = await nexo.run({ instruction: "Say hello", budgetUsd: 0.25 });
  console.log(result.output, result.costUsd);
} finally {
  await nexo.close();
}
```

- Pass keys in code without writing them to disk: `createNexo({ apiKeys: { anthropic: "…" } })`.
- `nexo.keys()`, `nexo.setKey()` and `nexo.removeKey()` manage stored keys. `nexo.webSearch(query)` searches without a model.
- The SDK denies every tool approval by default, so a backend never waits on a person. Pass `allowAll: true` to `createNexo` or `run` to auto-approve tool actions in sandboxed environments. Always pass `budgetUsd`.
- `checkSetup()` runs the doctor checks without starting the engine, for a start-up pre-flight.

## Security

nexo's tools run shell commands and edit files. Path confinement is not a sandbox. If you run nexo for other people, give each request its own workspace and use a container for real isolation.

## Develop

```sh
git clone https://github.com/hexdecimal16/nexo.git && cd nexo
npm ci
npm run nexo -- init     # run from source
npm run typecheck
npm test
npm run build            # release build into dist/
npm run bump -- patch    # set one version on every package
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free for any noncommercial use. Commercial use needs separate permission from the author.
