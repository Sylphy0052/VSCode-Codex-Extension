# 導入手順（まっさらなPCから）

VS Codeもエージェントも入っていないPCに、この拡張機能を入れて使えるようにするまでの手順。Windows（ネイティブ）、macOS、WSLの3通りを扱う。VS CodeとCLIが既に入っている場合は、[READMEの「インストール」](../README.md#インストール)だけで足りる。

CLIのインストールコマンドは2026-10-02時点の公式手順に合わせてある。手順が変わることがあるので、うまくいかないときは各節の公式ページを確認する。

## 全体の流れ

1. VS Codeを入れる
2. gitを入れる
3. Codex CLIかClaude Codeの少なくとも一方を入れ、ログインする
4. 拡張機能のVSIXを入手し、インストールする
5. 動作を確認する

この拡張機能は、AI本体もAPIキーも同梱しない。会話はすべて、手順3で入れたCLIを通して行う。CLIのログイン情報と設定（`~/.codex`、`~/.claude`）はCLIが自分で作るので、別のPCからコピーする必要はない。

どちらのCLIを使うにも、各サービスのアカウントが要る。

- Codex: ChatGPTのPlus・Pro・Business・Edu・Enterpriseプラン、またはOpenAIのAPIキー
- Claude Code: ClaudeのPro・Max・Team・Enterpriseプラン、またはConsoleアカウント（無料プランでは使えない）

## どの環境を選ぶか

- **macOS**: [macOSの手順](#macos)へ
- **Windowsで、Linuxのツールでプロジェクトを開発している**: [WSLの手順](#wsl)へ
- **Windowsで、Windowsのツールでプロジェクトを開発している**: [Windowsネイティブの手順](#windowsネイティブ)へ

Windowsでどちらにするか迷う場合はWSLを選ぶ。この拡張機能の開発と動作確認は主にLinux（WSLを含む）で行っており、Windowsネイティブでは通しの確認をしていない。

## macOS

### 1. VS Codeを入れる

[VS Codeのダウンロードページ](https://code.visualstudio.com/download)からmacOS版を入れる。1.90以降が必要。

VS Codeを開き、コマンドパレット（`Cmd+Shift+P`）で`Shell Command: Install 'code' command in PATH`を実行する。これでターミナルから`code`コマンドを使えるようになる。

### 2. gitを入れる

ターミナルで次を実行する。入っていなければ、Xcode Command Line Toolsのインストールを求める画面が出るので、それに従う。

```bash
git --version
```

### 3. CLIを入れてログインする

使うほうだけでよい。両方入れてもよい。

Codex CLI（[公式手順](https://github.com/openai/codex)）:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Claude Code（[公式手順](https://code.claude.com/docs/en/setup)）:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Homebrewを使っている場合は、代わりに`brew install --cask codex`、`brew install --cask claude-code`でも入る。

インストールが終わったら**ターミナルを開き直し**、[ログインする](#ログインする)へ進む。

### 4. 以降

[VSIXを入れる](#vsixを入れる)へ進む。

## WSL

WindowsでVS Codeを動かし、WSLのLinuxに接続して開発する構成。**CLIと拡張機能は、どちらもWSLの側に入れる。** 拡張機能はプロジェクトのある側（WSL）で動くので、Windows側に入れたCLIは使われない。

### 1. WSLを用意する

WSLが無い場合は、PowerShellを管理者として開いて次を実行し、PCを再起動する。既定ではUbuntuが入る。

```powershell
wsl --install
```

再起動後に「Ubuntu」を起動し、ユーザー名とパスワードを決める。詳しくは[Microsoftの手順](https://learn.microsoft.com/ja-jp/windows/wsl/install)を参照。

### 2. VS Codeを入れる

[VS Codeのダウンロードページ](https://code.visualstudio.com/download)から**Windows版**を入れる。1.90以降が必要。WSLの中にVS Codeを入れる必要はない。

VS Codeを開き、拡張機能ビューで「WSL」（発行元: Microsoft）をインストールする。

### 3. gitを入れる

ここから先は、WSLのターミナル（Ubuntu）で実行する。

```bash
sudo apt update
sudo apt install -y git curl
```

### 4. CLIを入れてログインする

使うほうだけでよい。両方入れてもよい。WSLのターミナルで実行する。

Codex CLI（[公式手順](https://github.com/openai/codex)）:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Claude Code（[公式手順](https://code.claude.com/docs/en/setup)）:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

インストールが終わったら**ターミナルを開き直し**、[ログインする](#ログインする)へ進む。

### 5. VS CodeからWSLに接続する

WSLのターミナルで、作業するフォルダへ移動して次を実行する。

```bash
code .
```

WindowsのVS Codeが開き、左下に「WSL: Ubuntu」と表示されればWSLへ接続できている。初回はWSL側にVS Code Serverが自動で入るので、少し時間がかかる。

### 6. 以降

[VSIXを入れる](#vsixを入れる)へ進む。**VSIXのインストールは、WSLに接続したウィンドウで行う。**

## Windowsネイティブ

WSLを使わず、Windows上で直接開発する構成。前述のとおり、この構成では通しの確認をしていない。

### 1. VS Codeを入れる

[VS Codeのダウンロードページ](https://code.visualstudio.com/download)からWindows版を入れる。1.90以降が必要。インストーラーの「PATHへの追加」にチェックを入れておくと、ターミナルから`code`コマンドを使える。

### 2. gitを入れる

[Git for Windows](https://git-scm.com/downloads/win)を入れる。worktreeを使う機能に必要なほか、Claude CodeはGit Bashがあるとそれをシェルとして使う。

### 3. CLIを入れてログインする

使うほうだけでよい。両方入れてもよい。PowerShellで実行する（管理者として開く必要はない）。

Codex CLI（[公式手順](https://github.com/openai/codex)）:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Claude Code（[公式手順](https://code.claude.com/docs/en/setup)）:

```powershell
irm https://claude.ai/install.ps1 | iex
```

`'irm' is not recognized`と出た場合は、PowerShellではなくコマンドプロンプトで実行している。プロンプトの先頭が`PS C:\`になっているウィンドウで実行し直す。

インストールが終わったら**PowerShellを開き直し**、[ログインする](#ログインする)へ進む。

### 4. 以降

[VSIXを入れる](#vsixを入れる)へ進む。

## ログインする

CLIを入れた環境（WSLの場合はWSLのターミナル）で実行する。

```bash
codex --version
claude --version
```

入れたほうのバージョンが表示されることを確認する。`command not found`や`認識されません`と出る場合は、ターミナルを開き直す。それでも出る場合は、各CLIの公式手順にあるPATHの設定を確認する。

続けてログインする。

- Codex: `codex`を実行し、ChatGPTアカウントでのサインインを選んでブラウザでログインする。APIキーを使う場合は、拡張機能を入れたあとサイドバーの「設定」ビューからも入力できる
- Claude Code: `claude`を実行し、表示に従ってブラウザでログインする

ログインできたら、CLIは終了してよい（Codexは`Ctrl+C`、Claude Codeは`/exit`）。

## VSIXを入れる

### 1. VSIXを入手する

[最新版のVSIX](https://github.com/Sylphy0052/VSCode-Codex-Extension/releases/latest/download/vscode-codex-extension.vsix)をブラウザでダウンロードする。URLは版が変わっても同じ。

ターミナルで取得する場合は次を実行する。WSLでコマンドからインストールする場合は、WSLのターミナルでこちらを使い、VSIXをWSL側に置く（ブラウザで落としたファイルはWindows側に置かれる）。

```bash
curl -fL -o vscode-codex-extension.vsix https://github.com/Sylphy0052/VSCode-Codex-Extension/releases/latest/download/vscode-codex-extension.vsix
```

### 2. インストールする

VS Codeの拡張機能ビューを開き、右上の「...」から「Install from VSIX...」を選び、ダウンロードしたファイルを指定する。

WSLの場合は、WSLに接続したウィンドウでこの操作を行う。インストール先として「WSL: Ubuntu」が表示されていることを確認する。

コマンドで入れる場合は、VSIXを置いたフォルダで次を実行する。WSLの場合は、WSLのターミナルで実行する。

```bash
code --install-extension vscode-codex-extension.vsix --force
```

### 3. 動作を確認する

1. コマンドパレット（Windows・WSLは`Ctrl+Shift+P`、macOSは`Cmd+Shift+P`）で`Developer: Reload Window`を実行する
2. 左端のアクティビティバーに**Agents**のアイコンが表示されることを確認する
3. Agentsを開き、新しい会話を始めて、短いメッセージに応答が返ってくることを確認する

アイコンが出ない場合は、開いているフォルダが信頼されているかを確認する。信頼されていないフォルダでは拡張機能が無効になる。コマンドパレットで`Workspaces: Manage Workspace Trust`を実行し、フォルダを信頼する。

「codex コマンドが見つかりません」「claude コマンドが見つかりません」と通知が出る場合は、次を確認する。

- WSLの場合、CLIをWindows側ではなくWSL側に入れたか
- CLIを入れたあとにVS Codeを起動し直したか（起動中のVS CodeはPATHの変更を読み直さない）
- それでも見つからない場合は、設定の`codex.executablePath`または`claude.executablePath`に実行ファイルの絶対パスを入れる。WSLでは、Windows側のユーザー設定ではなく「リモート [WSL: Ubuntu]」タブの設定に書く
  - Windowsでは`\`区切りと`/`区切りのどちらでも書ける（例: `C:\Users\<ユーザー名>\.local\bin\claude.exe`）。`claude`のように区切りもドライブ文字も含まない値はコマンド名とみなし、PATHから探す
  - パスが誤っていると「`codex.executablePath が実行できません: <パス>`」のように通知される

## 拡張機能のskill

拡張機能は、自分が持つskillをCodex・Claude Codeの会話へ読み込ませる。`~/.codex/skills`・`~/.claude/skills`には書き込まず、拡張機能から開いた会話にだけ効く。

- 同梱skill: VSIXに入っている。呼び出し名は`codex-ext:<skill名>`（Codexでは`$codex-ext:<skill名>`、Claude Codeでは`/codex-ext:<skill名>`）。止めたいときは設定の`agent.bundledSkills.enabled`を`false`にする
- 自分で追加するskill: Agentsの設定パネルでskillsセクションを開き、「フォルダからskillを追加」を押して`SKILL.md`を含むフォルダを選ぶ。呼び出し名は`codex-ext-user:<フォルダ名>`になる。フォルダは拡張機能の保存領域へ写されるため、元のフォルダを書き換えても反映されない。書き換えたら一度削除して追加し直す
  - 追加したskillは、削除するまで拡張機能から開く全ての会話で読み込まれる。信頼できるフォルダだけを追加する
  - シンボリックリンク・`.git`・`node_modules`は写さない。写す分がファイル1000個か合計10MBを超えるフォルダは追加できない

どちらも、次に開いた会話から使える。設定パネルのskill一覧では「拡張機能」と表示される。

## 必要に応じて入れるもの

次のものは無くても拡張機能は動く。無い場合は、対応する機能だけが使えない。

- GitHub CLI（`gh`）とログイン: Forge Hub、ロードマップ、タスク監視でGitHubのIssue・PRを扱う
- GitLab CLI（`glab`）とログイン: 同じ機能でGitLabを扱う
  - Forge HubのGitLab側は、依頼先のCLIに`gitlab-develop`・`gitlab-review`・`gitlab-cleanup`のskillがあれば、それを呼ぶ（Codexは`$gitlab-develop`、Claude Codeは`/gitlab-develop`の形）。skillは拡張機能に含まれていないため、無ければ計画の記録・MR作成・自己レビュー・後片付けの手順を平文で依頼する
- Google ChromeとNode.js（`npx`）: ChatGPTとの議論機能（WebGPT連携）。詳しくは[READMEの「WebGPTとの議論」](../README.md#webgptとの議論)
- 音声プレイヤー: 通知音。macOSとWindowsは標準のもので鳴る。Linux・WSLでは`paplay`、`pw-play`、`aplay`、`ffplay`のいずれかが要る。無い場合は音が鳴らないだけ

## 更新とアンインストール

[READMEの「更新する」「アンインストールする」](../README.md#更新する)を参照する。
