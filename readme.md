# Babli CLI

Use Babli.ai from your commandline. Sync your project with Babli.

## Use

When you have new keys to translate. Add them to one of your translation files. And then 

- run `babli login` if you haven't already
- `babli push` - push new keys/translations to Babli.ai
- translate them on [babli.ai](https://www.babli.ai/app)
- `babli pull` - pull the new translations to your project

## Install

```bash
npm install -g babli
```

## Automatic Setup (coming soon)

create new Babli.ai project and connect it to your local project
```bash
babli create-project
``` 

## Manual Setup

1. Create a `babli.json` or `babli.yaml` file in the root of your project
2. Create an empty project in [babli.ai](https://www.babli.ai/app) and get your projectId
3. Add your projectId and pattern to find your translation files
    ```json
    {
    "projectId": "<your projectId>",
    "translationFiles": [{ "pattern": "src/translations/{{lang}}.json" }]
    }
    ```
4. Then you can push your keys from your project `babli push`
