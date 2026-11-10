# Maintaining This Fork

`cosmtrek/t3code` is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).
The goal is to ship a personal build while staying able to sync upstream and send PRs upstream.

## Branches

| Branch      | Purpose                                                               | Cut from        |
| ----------- | --------------------------------------------------------------------- | --------------- |
| `main`      | Mirror of upstream. **Never commit here.**                            | —               |
| `r/main`    | Personal mainline: upstream plus my patches. Releases ship from here. | `main`          |
| `r/<name>`  | Personal work                                                         | `r/main`        |
| `pr/<name>` | Upstream PR, one problem per branch                                   | `upstream/main` |

Rule of thumb: if upstream would want the change, use `pr/` and cherry-pick it into `r/main` while
the PR is open. Only fork-only changes go on `r/`.

```bash
git remote -v                   # origin = cosmtrek/t3code, upstream = pingdotgg/t3code
git config rerere.enabled true  # resolve a repeated conflict once
```

## Syncing upstream

```bash
git fetch upstream
git push origin upstream/main:main      # update the mirror
git switch r/main
git rebase upstream/main                # move the patch stack onto the new base
git range-diff ORIG_HEAD...HEAD         # check that no patch changed unexpectedly
git push --force-with-lease origin r/main
```

Then run `git rebase r/main` on any personal branch that has not landed yet.

Sync after an upstream stable release so the version base stays clear (see Versions).

## Sending a PR upstream

```bash
git switch -c pr/xxx upstream/main
# edit and commit
git push -u origin pr/xxx
gh pr create --repo pingdotgg/t3code --base main --head cosmtrek:pr/xxx
```

Read upstream's `CONTRIBUTING.md` first. PRs that do not follow it are closed automatically.

## Cherry-picking upstream PRs

A merged PR (upstream squash-merges, so one PR is one commit):

```bash
sha=$(git log upstream/main --format=%H --grep='(#12345)$' -1)
git cherry-pick -x "$sha"
```

This is rarely needed, because the next sync brings it in.

An open PR:

```bash
git fetch upstream pull/12345/head:up/pr-12345
base=$(git merge-base up/pr-12345 upstream/main)
git cherry-pick -x -e "$base..up/pr-12345"   # add an "Upstream-PR: #12345" line to the message
```

Do not use `git merge --squash`. It brings in the upstream commits between the PR's base and `r/main`.

Once upstream merges the PR, a rebase conflict on it resolves in upstream's favor: `git rebase --skip`
the local copy. Before syncing, list which ones have merged:

```bash
git log upstream/main..r/main --format=%B | grep -o 'Upstream-PR: #[0-9]*' | grep -o '[0-9]*' | sort -u |
  while read n; do echo "#$n $(gh pr view "$n" --repo pingdotgg/t3code --json state -q .state)"; done
```

## Versions

Desktop/server and mobile have separate version lines, as upstream does. Upstream releases them
separately with no version coupling. Compatibility comes from keeping `packages/contracts` changes
additive.

### Desktop / server / CLI: `X.Y.Z-r.N`

- `X.Y.Z`: the upstream stable release `r/main` is based on, such as upstream `v0.1.8`.
- `N`: increases by one per release and restarts at 1 when the base changes.
- Example: `0.1.8-r.1` → `0.1.8-r.2` → sync to upstream 0.1.9 → `0.1.9-r.1`. The tag is `v0.1.8-r.1`.
- Test builds get no version scheme of their own. To test a packaged build, use the release
  workflow's `preview` channel: its version is generated, and it has no update feed, so releases are
  never offered it. Day-to-day checks use `vp run dev`.

### Mobile: `MAJOR.MINOR.PATCH`, numbers only

- Starts at `1.0.0`. PATCH for JS-only changes, MINOR for native changes or larger features.
- Numbers only, because iOS `CFBundleShortVersionString` rejects suffixes.
- `versionCode` is the GitHub Actions run number, so it always increases.
- Test and daily builds differ by `APP_VARIANT`, not by version: `preview` is the test build and
  `production` the daily one. They have different package names and install side by side.

## Android builds (GitHub Actions)

Workflow: `.github/workflows/fork-android-apk.yml`, manual trigger only.

```bash
gh workflow run fork-android-apk.yml --ref r/main -f version=1.0.0 -f variant=preview
gh run watch                        # wait for the build
gh run download --name t3code-preview-1.0.0-arm64-v8a
```

Repository settings it reads (Settings → Secrets and variables → Actions):

| Kind     | Name                                                 | Notes                                                                                    |
| -------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Variable | `T3CODE_ANDROID_PACKAGE`                             | **Required.** Package prefix, `com.rickoyu.t3code`. Preview adds `.preview`, dev `.dev`  |
| Secret   | `ANDROID_KEYSTORE_BASE64`                            | Base64 of the signing keystore                                                           |
| Secret   | `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD` | Keystore password and key password                                                       |
| Variable | `ANDROID_KEY_ALIAS`                                  | Key alias. A variable, because a secret would mask every occurrence of its value in logs |

Without a keystore the build still runs, signed with the public React Native debug key. That is fine
for a quick try only: once an app is installed with one key, a build signed with another cannot
update it. Create your own keystore early and **back it up**:

```bash
keytool -genkeypair -v -keystore t3code-release.keystore -alias t3code \
  -keyalg RSA -keysize 4096 -validity 36500
base64 -w0 t3code-release.keystore | gh secret set ANDROID_KEYSTORE_BASE64 -R cosmtrek/t3code
gh secret set ANDROID_KEYSTORE_PASSWORD -R cosmtrek/t3code
gh variable set ANDROID_KEY_ALIAS -R cosmtrek/t3code --body t3code
gh secret set ANDROID_KEY_PASSWORD -R cosmtrek/t3code
gh variable set T3CODE_ANDROID_PACKAGE -R cosmtrek/t3code --body com.rickoyu.t3code
```

Current limits:

- OTA updates are off (`T3CODE_MOBILE_UPDATES_ENABLED=0`). Otherwise the app would pull JS from
  upstream's EAS project and replace this fork's changes. Using OTA needs an own EAS project, with
  `updates.url` and `extra.eas.projectId` in `app.config.ts` replaced.
- No `google-services.json`, so push notifications do not arrive.
- `app.t3.codes` thread links verify only the official packages, so they open in the browser.
- T3 Connect / Clerk sign-in uses upstream's configuration and may not work under another package.
  Connect to the server directly over the LAN or Tailscale.

## GitHub Actions in the fork

Most upstream workflows run on Blacksmith runners, which a fork does not have, so their jobs stay
queued (for example `CI` on a push to `main`). Disable the ones you do not need and re-enable them
when you do:

```bash
gh workflow list -R cosmtrek/t3code
gh workflow disable CI -R cosmtrek/t3code
```

The desktop release workflow (`release.yml`) depends on Blacksmith runners, Apple signing, npm,
Vercel, and more, so it **does not run as-is** in the fork. Shipping the Mac app needs a separate,
smaller fork workflow that builds only the macOS DMG with
`T3CODE_DESKTOP_UPDATE_REPOSITORY=cosmtrek/t3code`. That workflow must also publish `-r.N` versions
as full releases: upstream publishes suffixed versions as prereleases, which the desktop stable
channel ignores.

## Patches on `r/main`

Review this list after every sync, and upstream whatever upstream would take.

| Patch                                                  | Files                                    | Upstreamable                   |
| ------------------------------------------------------ | ---------------------------------------- | ------------------------------ |
| Fork maintenance guide                                 | `FORK.md`                                | No                             |
| Android APK build workflow                             | `.github/workflows/fork-android-apk.yml` | No                             |
| `T3CODE_ANDROID_PACKAGE` overrides the Android package | `apps/mobile/app.config.ts` and its test | Yes, as a fork-friendly option |
