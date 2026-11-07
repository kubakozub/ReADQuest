# ReADQuest

A local Chrome MV3 extension that tags and blocks traffic according to a bug bounty
program's scope. It does what a cloud rule editor does, without the cloud and with
verification built in, because the lesson that produced it was this: **"Active" in the
interface does not mean the rule is running.**

A rule that the engine silently refused looks identical to a rule that works. You find
out either from a line in a console nobody opened, or from a header that never arrived
at the target. Both are discovered late.

Three properties follow from that:

1. **Nothing leaves the machine.** The rules are a file on disk. The restriction "no
   `Cookie` and no `Authorization` headers, because the rules go to a cloud service"
   stops applying for technical reasons, and remains only as a deliberate choice.
2. **Verification is part of the tool, not a procedure beside it.** After every change
   the extension reads back from the Chrome engine what was actually installed and
   compares it against what was intended. A dead rule shows up immediately as a red
   error rather than as a console message somebody has to stumble into.
3. **The match tester sends no requests.** It uses `testMatchOutcome`, which asks the
   engine "what would you do with this URL", with no network traffic at all. That means
   the "no leak to an out-of-scope host" check can be made without visiting an
   out-of-scope host.

## Install

```bash
node tools/sync-manifest.mjs
```

Then open `chrome://extensions`, enable developer mode, choose **Load unpacked** and
point it at the `ReADQuest` directory. It has to be unpacked: the match log
(`onRuleMatchedDebug`) and the tester (`testMatchOutcome`) are available in Chrome only
to locally loaded extensions.

To check the configuration without Chrome, which is worth doing after every scope edit:

```bash
node tools/selftest.mjs
```

That replays the DNR matching logic in Node and runs the whole `verification` battery
from `scope.config.json` through it in **two passes**: once in the extension's default
state (the same `DEFAULT_TOGGLES` constant the service worker uses), and once in the
exception state with the production block lifted. The second pass is allowed exactly one
difference: cases marked `expect: "block"` become `none`. Anything else means that
lifting the block also moved tagging or exclusions, which it has no business doing.

## What the 2 KB limit does and does not cover

Chrome's declarativeNetRequest has a 2 KB memory limit that rejects rules, and it is
widely reported as a limit on rules in general. It is not. It applies to one field.

| field | what it is | subject to the 2 KB limit |
|---|---|---|
| `regexFilter` | an RE2 expression over the full URL | **yes** |
| `urlFilter` | a pattern using `*`, `\|`, `\|\|`, `^` | no |
| `requestDomains` | a plain list of domains; matches the domain **and its subdomains** | no |
| `excludedRequestDomains` | the same, as an exclusion | no |

So if a tool maps a host wildcard onto `requestDomains` or `urlFilter`, the alternation
problem disappears and a list of hosts can stay in a single rule. If it maps everything
onto `regexFilter`, the list has to be split.

**A size test does not answer this question.** Testing whether a rule set fits inside
2 KB is indirect: it reports "the limit was not exceeded", not "no regex was used". Two
conditions can fit inside 2 KB and still be compiled as a regex, so the absence of an
error proves nothing. The direct check, run in the service worker console of whichever
extension is in question:

```js
await chrome.declarativeNetRequest.getDynamicRules()
```

That returns the rules as the engine sees them. Read the `condition` of each one and look
for `regexFilter` against `requestDomains` or `urlFilter`. No guessing. It is worth adding
`getSessionRules()` and `getEnabledRulesets()`, since an extension may use several paths.

**In ReADQuest the question is moot**, because compilation is explicit:

- `mode: "domainAndSubdomains"` produces `requestDomains: [host]` and no regex at all;
- `mode: "exact"` produces a short anchored regex, 41 characters in the longest case
  against a limit of roughly 2000;
- every generated regex is passed through `isRegexSupported()` before installation, which
  is Chrome's own RE2 validator. That is the same condition that surfaces elsewhere as
  *"was skipped ... 2KB memory limit"*, checked in advance and shown in the Diagnostics
  tab instead.

**One rule per host, even though nothing forces it.** Splitting is no longer required by
the limit, but it stays, because only then can the match log and the tester say *which*
scope entry fired. Against a limit of 5000 dynamic rules, 25 rules cost nothing.

## How it is built

```
scope.config.json        the single source of truth: hosts, exclusions, blocks, tests
src/compile.js           config to DNR rules (a pure function, no chrome.* calls)
src/background.js        rule installation, health checks, match log, tester
src/popup.*              toggles and four tabs
tools/sync-manifest.mjs  regenerates host_permissions from the config
tools/selftest.mjs       an offline replica of DNR matching
```

Three host matching modes:

| `mode` | meaning | implementation |
|---|---|---|
| `exact` | that host only | `^https?://host(:\d+)?/` |
| `domainAndSubdomains` | the host and its subdomains | `requestDomains: [host]` |
| `subdomains` | subdomains only, not the apex | `^https?://([^/:?#@]+\.)+host(:\d+)?/` |

`domainAndSubdomains` is exactly equivalent to the regex `^(.+\.)?domain\.tld$`, so the
apex is included. A scope written as `*.wpengine.io` is sometimes read as "subdomains
only"; if that is the intended reading, set `mode` to `subdomains`.

Priorities: production block 300, then exclusion 200, then tagging 10. The block always
wins, including over an exclusion.

### The header

The browser's own `navigator.userAgent`, a space, then `identity.marker`. The user agent
is not hardcoded, so it does not go stale when Chrome updates. Only the HTTP header is
replaced: `navigator.userAgent` inside page JavaScript is left untouched, which limits the
risk of an application behaving differently because of the marker. To override the value,
set `identity.userAgentOverride` in the config.

## Verification protocol: where each step is checked

| step | where |
|---|---|
| 1. no rule was skipped | the **Diagnostics** tab. A green result means every rule was confirmed by reading back from the engine, no regex was rejected, no rule was orphaned, and `host_permissions` is complete |
| 2. the target is being tagged | the **Tester** tab statically, plus the **Match log** and DevTools Network during a real session |
| 3. no leak off-scope | the **Tester** tab. The battery contains both cases that defeated an earlier hand-written rule: the domain appearing in a query string, and the domain appearing as a prefix (`example.pl.anything.tld`) |
| 4. production is blocked | the **Tester** tab, with the toggle on by default, confirmed in Network on a real visit |

The **Rules** tab shows the compiled JSON with a copy button, which is the artifact to
attach to a report. Copy it only once Diagnostics is green and the Tester is fully green.

The extension **never initiates a request on its own**. The tester runs against a
simulation of the engine and the log is passive, so the constraint "no requests beyond
those in the verification protocol" holds by construction rather than by discipline.

## Known limitations

- **`host_permissions` has to cover the hosts being tagged.** Without it `modifyHeaders`
  is not permitted to add the header even though the rule will look active: exactly the
  kind of silent failure this tool exists to catch. Diagnostics detects it and says what
  to run. The side effect is useful: the origin list in the manifest acts as a second
  safety net, because even a wrong rule cannot add a header to a host that was never
  deliberately listed.
- **Subresources loaded from an out-of-scope host.** For `modifyHeaders` Chrome requires
  permission for the request initiator as well. If the log shows that subresources from
  an in-scope host are not getting the header, add `"*://*/*"` to `host_permissions`,
  which widens the permission deliberately in exchange for coverage.
- **A production block covers only the hosts it enumerates.** It is a safety net for
  listed domains, not a guarantee, so a scope entry such as a catch-all "Other" category
  is not covered by it.
- The match log lives in `storage.session`, so it disappears when the browser restarts.
  If it is going to be evidence in a report, copy it before closing.
- The matching logic is tested offline against the DNR simulator. Running it in a real
  Chrome profile is a separate step and is the one thing the test suite cannot do for you.

## License

MIT, see [LICENSE](LICENSE).
