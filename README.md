# nexo

An AI agent engine that runs on your machine. It tracks what each run costs, scores the results, and keeps every run inspectable. Use it from the terminal, from a web run inspector, or from Node code.

Requires Node 22.19 or newer.

## Install

From npm:

```sh
npm install -g @hexdecimal16/nexo
```

From source:

```sh
git clone https://github.com/hexdecimal16/nexo.git
cd nexo
npm ci
npm run nexo -- init
```

To install a `nexo` command globally from your checkout:

```sh
npm run build
(cd dist && npm pack --pack-destination /tmp) && npm install -g /tmp/nexo-*.tgz
```

## First run

```sh
nexo init      # pick models, store API keys, make one small test call
nexo doctor    # check Node, config, keys and the data directory
nexo           # start a chat
nexo run "summarize this folder" --budget 0.25
nexo ui        # open the run inspector (traces, costs, scores)
```

For scripts, `nexo init --yes --s1 <provider/id> --s2 <provider/id>` runs without prompts and reads keys from the provider's environment variable. `nexo doctor --json` prints the checks for automation.

Data lives in `~/.nexo` (set `NEXO_HOME` to change it).

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

The SDK denies every tool approval by default, so a backend never waits on a person. Always pass `budgetUsd`. `checkSetup()` runs the doctor checks without starting the engine, which suits a start-up pre-flight.

## Security

nexo tools run shell commands and edit files. Path confinement is not a sandbox. If you run nexo for other people, give each request its own workspace and use a container for real isolation.

## Develop

```sh
npm run typecheck
npm test
npm run build        # release build into dist/
npm run bump -- minor
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free for any noncommercial use. Commercial use needs separate permission from the author.
