# 个人 Fork 维护指南

本仓库 `cosmtrek/t3code` 是 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的个人 fork。
目标：维护自己的版本，同时随时能同步上游、给上游提 PR。

## 分支

| 分支        | 作用                                       | 从哪切          |
| ----------- | ------------------------------------------ | --------------- |
| `main`      | 上游镜像，**永不提交**                     | —               |
| `r/main`    | 个人主线 = 上游 + 我的补丁，发布都从这里出 | `main`          |
| `r/<name>`  | 个人需求                                   | `r/main`        |
| `pr/<name>` | 给上游的 PR，一个分支只解决一个问题        | `upstream/main` |

判断标准：上游会要的改动走 `pr/`，提 PR 后 cherry-pick 到 `r/main` 先用；只有私有改动才走 `r/`。

```bash
git remote -v                   # origin = cosmtrek/t3code, upstream = pingdotgg/t3code
git config rerere.enabled true  # 同样的冲突只解决一次
```

## 同步上游

```bash
git fetch upstream
git push origin upstream/main:main      # 更新镜像
git switch r/main
git rebase upstream/main                # 补丁栈挪到新基线
git range-diff ORIG_HEAD...HEAD         # 检查补丁是否变形
git push --force-with-lease origin r/main
```

还没合入的个人分支随后执行 `git rebase r/main`。

建议在上游发 stable 后同步，这样版本号的基线清晰（见下文）。

## 给上游提 PR

```bash
git switch -c pr/xxx upstream/main
# 修改、提交
git push -u origin pr/xxx
gh pr create --repo pingdotgg/t3code --base main --head cosmtrek:pr/xxx
```

先读上游的 `CONTRIBUTING.md`，不合规的 PR 会被自动关闭。

## Cherry-pick 上游 PR

已合并的 PR（上游是 squash merge，一个 PR 对应一个提交）：

```bash
sha=$(git log upstream/main --format=%H --grep='(#12345)$' -1)
git cherry-pick -x "$sha"
```

通常不用这么做，下次同步时它会自动进来。

还没合并的 PR：

```bash
git fetch upstream pull/12345/head:up/pr-12345
base=$(git merge-base up/pr-12345 upstream/main)
git cherry-pick -x -e "$base..up/pr-12345"   # 在提交信息里加一行 Upstream-PR: #12345
```

不要用 `git merge --squash`，否则会带进 PR 基线和 `r/main` 之间的上游提交。

这个 PR 后来被上游合并后，rebase 时如果冲突，以上游为准：`git rebase --skip` 掉自己那份。
同步前可以先看看哪些已经合并：

```bash
git log upstream/main..r/main --format=%B | grep -o 'Upstream-PR: #[0-9]*' | grep -o '[0-9]*' | sort -u |
  while read n; do echo "#$n $(gh pr view "$n" --repo pingdotgg/t3code --json state -q .state)"; done
```

## 版本号

桌面/服务端和移动端是两条独立的版本线，和上游一致。上游的这两条线也是分别发布的，互相没有版本绑定，兼容性靠 `packages/contracts` 只做增量修改来保证。

### 桌面 / 服务端 / CLI：`X.Y.Z-r.N`

- `X.Y.Z`：`r/main` 当前基于的上游 stable 版本，例如上游 `v0.1.8`。
- `N`：每发一版 +1。基线换了就从 1 重新开始。
- 例：`0.1.8-r.1` → `0.1.8-r.2` → 同步到上游 0.1.9 → `0.1.9-r.1`；tag 为 `v0.1.8-r.1`。
- 测试版：不额外设计版本号。需要测打包产物时，用上游 release workflow 的 `preview` 通道（版本号自动生成，没有更新源，不会推送给正式版）。日常验证用 `vp run dev`。

### 移动端：`MAJOR.MINOR.PATCH` 纯数字

- 从 `1.0.0` 开始。只改 JS 时 PATCH +1，原生改动或较大的功能 MINOR +1。
- 必须是纯数字，因为 iOS 的 `CFBundleShortVersionString` 不接受后缀。
- `versionCode` 用 GitHub Actions 的 run number，自动递增。
- 测试版和正式版用 `APP_VARIANT` 区分，不靠版本号：`preview` 是测试版，`production` 是正式版。两者包名不同，可以同时安装。

## Android 构建（GitHub Actions）

Workflow：`.github/workflows/fork-android-apk.yml`，只能手动触发。

```bash
gh workflow run fork-android-apk.yml --ref r/main -f version=1.0.0 -f variant=preview
gh run watch                        # 等待构建完成
gh run download --name t3code-preview-1.0.0-arm64-v8a
```

用到的仓库配置（Settings → Secrets and variables → Actions）：

| 类型     | 名称                                                                       | 说明                                                                                         |
| -------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Variable | `T3CODE_ANDROID_PACKAGE`                                                   | **必填**。包名前缀，例如 `dev.cosmtrek.t3code`；preview 会自动加上 `.preview`，dev 加 `.dev` |
| Secret   | `ANDROID_KEYSTORE_BASE64`                                                  | 签名 keystore 的 base64                                                                      |
| Secret   | `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | keystore 的密码、alias 和 key 密码                                                           |

不配置 keystore 也能构建，但会用公开的 React Native debug key 签名，只适合临时试用。
一旦用某个 key 装过 app，换 key 之后就无法覆盖安装，所以尽早生成并**备份好**自己的 keystore：

```bash
keytool -genkeypair -v -keystore t3code-release.keystore -alias t3code \
  -keyalg RSA -keysize 4096 -validity 36500
base64 -w0 t3code-release.keystore | gh secret set ANDROID_KEYSTORE_BASE64 -R cosmtrek/t3code
gh secret set ANDROID_KEYSTORE_PASSWORD -R cosmtrek/t3code
gh secret set ANDROID_KEY_ALIAS -R cosmtrek/t3code --body t3code
gh secret set ANDROID_KEY_PASSWORD -R cosmtrek/t3code
gh variable set T3CODE_ANDROID_PACKAGE -R cosmtrek/t3code --body dev.cosmtrek.t3code
```

目前的限制：

- 构建时关闭了 OTA（`T3CODE_MOBILE_UPDATES_ENABLED=0`）。否则 app 会去上游的 EAS 项目拉 JS，覆盖掉我的改动。以后要用 OTA，需要建自己的 EAS 项目，并替换 `app.config.ts` 里的 `updates.url` 和 `extra.eas.projectId`。
- 没有配置 `google-services.json`，所以收不到推送通知。
- `app.t3.codes` 的线程链接只认官方包名，在我的包里会用浏览器打开。
- T3 Connect / Clerk 登录用的是上游的配置，在独立包名下可能不可用。用局域网或 Tailscale 直连服务端。

## Fork 里的 GitHub Actions

上游的 workflow 大多跑在 Blacksmith runner 上，fork 没有这类 runner，任务会一直排队（例如 push 到 `main` 时触发的 `CI`）。
可以禁用不需要的 workflow，需要时再启用：

```bash
gh workflow list -R cosmtrek/t3code
gh workflow disable CI -R cosmtrek/t3code
```

桌面端的发布流程（`release.yml`）依赖 Blacksmith runner、Apple 签名、npm、Vercel 等，在 fork 里**不能直接用**。
要发布 Mac 版，需要单独做一个精简的 fork workflow：只构建 macOS DMG，并设置
`T3CODE_DESKTOP_UPDATE_REPOSITORY=cosmtrek/t3code`。到时还要让 `-r.N` 版本按正式 release 发布：上游会把带后缀的版本发成 prerelease，而桌面 stable 通道看不到 prerelease。

## `r/main` 上的私有补丁

每次同步后核对这份清单；能推给上游的尽量推掉。

| 补丁                                       | 文件                                     | 能否推给上游                 |
| ------------------------------------------ | ---------------------------------------- | ---------------------------- |
| Fork 维护文档                              | `FORK.md`                                | 否                           |
| Android APK 构建 workflow                  | `.github/workflows/fork-android-apk.yml` | 否                           |
| `T3CODE_ANDROID_PACKAGE` 覆盖 Android 包名 | `apps/mobile/app.config.ts` 和对应测试   | 可以，作为 fork 友好的配置项 |
