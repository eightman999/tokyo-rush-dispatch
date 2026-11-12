# Cloud Runへのデプロイ

公開URL：[首都圏輸送指令室](https://tokyo-rush-dispatch-999875103002.asia-northeast1.run.app)

## 構成

- プロジェクト：`gemini-workshop-20261112`
- リージョン：`asia-northeast1`（東京）
- サービス：`tokyo-rush-dispatch`
- イメージ：`asia-northeast1-docker.pkg.dev/gemini-workshop-20261112/cloud-run-source-deploy/tokyo-rush-dispatch:20261112-v2`
- ポート：8080、CPU：1、メモリ：256MiB、同時リクエスト：80
- 最小インスタンス：0、サービス全体の最大インスタンス：2、リクエスト課金
- 認証なしの公開アクセス。ゲームの計算と記録は各ブラウザ内で動作。

最小0台でもビルド・コンテナ保存・通信・実行等に費用が発生し得ます。
最大2台の設定は請求額の絶対上限ではありません。

## 本番サーバー

Node.js 24 Alpine。`0.0.0.0:$PORT`で待ち受けます。
`/health`は200を返し、`/`とビルド済みのJS/CSS/SVGを配信します。
GET/HEAD以外は405、存在しないファイルと非公開ファイルは404。
ハッシュ付きアセットはimmutable、HTMLはno-cacheとし、更新時の古いHTMLの残留を防ぎます。
実行用イメージは非rootユーザーで動作し、node_modules・ソース・認証情報は含めません。

## ビルドと再デプロイ

既存のgcloudログインと、対象プロジェクトへのデプロイ権限が必要です。
Google Cloud認証情報をリポジトリやコンテナにコピーしないでください。

```sh
npm ci
npm test
docker buildx build --platform linux/amd64 --load \
  -t asia-northeast1-docker.pkg.dev/gemini-workshop-20261112/cloud-run-source-deploy/tokyo-rush-dispatch:20261112-v2 .
```

Artifact Registryへのpushにはgcloud credential helperを使います。
今回の実行では一時的なDocker設定ファイルにレジストリ用のhelper参照だけを置き、
既存のDocker設定を変更せず、トークンを出力・保存せずにpushしています。

push後のデプロイ：

```sh
gcloud run deploy tokyo-rush-dispatch \
  --image=asia-northeast1-docker.pkg.dev/gemini-workshop-20261112/cloud-run-source-deploy/tokyo-rush-dispatch:20261112-v2 \
  --project=gemini-workshop-20261112 --region=asia-northeast1 \
  --allow-unauthenticated --ingress=all --port=8080 \
  --memory=256Mi --cpu=1 --min=0 --max=2 --concurrency=80 \
  --timeout=60 --no-cpu-boost --quiet
```

更新時には新しいイメージタグを指定してください。

```sh
gcloud run services describe tokyo-rush-dispatch \
  --project=gemini-workshop-20261112 --region=asia-northeast1 \
  --format='value(status.url)'
```

## 初回構築時の記録

Cloud Run、Cloud Build、Artifact Registry APIを有効化。
最初にsource deployを試しましたが、既定ビルド用サービスアカウントのソース読取権限が不足していました。
そのためローカルDockerでlinux/amd64イメージをビルドして配信する方式を採用。
このエラーへの対応としてサービスアカウントの権限追加は行っていません。

ローカルとコンテナ内でテスト17件がPASS。配信サーバーのテストはHTML・JSの配信、HEAD、
health、CSP、キャッシュ設定、非公開パス・不正なURL・POST拒否を含みます。
`.gcloudignore`と`.dockerignore`はアップロードするファイルを許可リストで制限しています。

初回の公開HTTP検証で`/healthz`は入口側の404となることを確認。
[Cloud Runの予約URL仕様](https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths)に合わせ、`/health`に変更しています。

## 公開後の検証（2026-11-12）

- 修正版リビジョン：`tokyo-rush-dispatch-00002-5qp`、Ready、トラフィック100%。
- 認証ヘッダーなしでHTML、JS、CSS、favicon、`/health`が200。
- `/.env`、`/server.mjs`は404。非公開のファイルを配信しないことを確認。
- 公開URLをブラウザで開き、時刻07:30:00→07:30:10の進行とスコア更新を確認。
- 日吉の直通中止を発行し、指令ログ追加・重複発行不可を確認。
- ブラウザ確認時点でコンソールのerror・warnなし。
