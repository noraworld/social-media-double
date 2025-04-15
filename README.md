# Social Media Double
Social Media Double lets you share a comment posted on a GitHub issue with your social media account.

A compatible social media service is only Misskey now, but other ones such as Twitter (subsequently X) or Mastodon will be supported down the road.

## Setup
1. Generate a GitHub personal access token and a Misskey API token
2. Navigate to Actions secrets and variables page (`https://github.com/<USER>/<REPO>/settings/secrets/actions`) and store them
3. Create a workflow as follows

### Workflow
```yaml
name: Social Media Double

on:
  issue_comment:
    types: [created]

jobs:
  build:
    if: ${{ github.event.issue.number == 2 }}
    runs-on: ubuntu-latest
    concurrency:
      group: social-media-double
      cancel-in-progress: true
    steps:
      - name: Post to social media
        uses: noraworld/social-media-double@main
        with:
          misskey_api_token: MISSKEY_API_KEY
          misskey_server: misskey.io
          personal_access_token: GH_TOKEN
        env:
          GH_TOKEN: ${{ secrets.GH_TOKEN }}
          MISSKEY_API_KEY: ${{ secrets.MISSKEY_API_KEY }}
```

#### Inputs
| Key | Description | Type | Default | Examples |
| --- | ----------- | :--: | ------- | -------- |
| `misskey_api_token` | Your secret name whose value stores your Misskey API token (NOT a token itself) | String | `""` | `MISSKEY_API_KEY` |
| `misskey_server` | A server domain where your account exists | String | `""` | misskey.io |
| `personal_access_token` | Your secret name whose value stores your GitHub personal access token (NOT a token itself) | String | `""` | `GH_TOKEN` |

## Development
```shell
cp -i .env.sample .env
node --env-file=.env app.js
```
