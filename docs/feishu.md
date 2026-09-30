# Feishu adaptation

This repository is a fork of
[nicobailon/pi-subagents v0.73.1](https://github.com/nicobailon/pi-subagents/tree/v0.73.1).
The upstream MIT license and attribution are retained. The fork changes resource
discovery and native child initialization for
[Feishu Agent](https://github.com/Azhi-ss/feishu-agent); it reuses the existing
delegation, workflow, foreground/background, cancellation and result machinery.
Pi SDK development dependencies are pinned to the host's tested `0.87.1`.

## Install locally

Build the matching Feishu Agent host, then from this repository:

```bash
npm ci
feishu install /absolute/path/to/pi-subagents-feishu
```

Restart Feishu. This registers the source directory as a local Package; keep the
checkout in place. `-l` limits registration to the current Feishu Project. The
package retains the upstream `pi-subagents` name for its existing self-imports;
do not register the original npm package and this fork together.

To produce a compiled package for distribution, use upstream's `npm run build:pkg`
and its `dist-pkg/` output. Source installation does not require this step.

## Host contract

Feishu sets `FEISHU_SUBAGENT_HOST_MODULE` to its adapter module and
`FEISHU_SUBAGENT_CONTEXT` to an immutable private JSON snapshot. The snapshot has
version `1`, Feishu home/project paths, the parent's resolved Skill catalog,
system prompt and a destructive-approval boolean. It carries no credentials.
The adapter exports `createFeishuSubagentResources` and returns the host's SDK
resource loader, settings manager and model runtime. Missing/invalid host data
fails rather than enabling ordinary Pi discovery.

In Feishu mode:

- Skills come from the snapshot, including its same-name winners and official
  cache choice. Agent-local Skill paths cannot introduce an alternate catalog.
- Agent definitions, configuration and runtime state use Feishu private roots.
  Automatic discovery skips `.agents`, `.pi`, Codex/Claude and global npm roots.
- Both native execution modes use the host's identity, read-only model
  authentication and lark destructive-command Guard. Child prompt wording does
  not grant approval. Parent Mem0/Remote extensions are not implicitly loaded.
- External CLI/job runners and saved-machine placement are rejected because they
  cannot satisfy this host contract. Native `fresh` and `fork` remain supported.
- This is not a filesystem sandbox. Core file/shell tools retain the user's
  permissions, as they do in Feishu Agent.

Without these host variables, upstream behavior remains unchanged. Do not set
them manually to use this fork in ordinary Pi.

## Updating upstream

Keep `upstream` pointed at `https://github.com/nicobailon/pi-subagents.git` and
merge a deliberately selected tag into the adaptation branch. Review resource
discovery, child session creation and detached-runner changes; keep the Feishu
diff confined to these boundaries. Run the fork tests and the host's real CLI
integration test with `FEISHU_SUBAGENTS_PACKAGE` pointing to this checkout before
using an updated version. Do not patch installed dependencies or the Pi SDK.
