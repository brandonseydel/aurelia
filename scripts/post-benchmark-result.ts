import { CIEnv } from './ci-env';

async function main(): Promise<void> {
  let url;
  const rows = await CIEnv.circleGet(`project/github/aurelia/aurelia/${CIEnv.CIRCLE_BUILD_NUM}/artifacts`);
  for (const row of rows) {
    if (row.url.endsWith('table.html')) {
      url = row.url;
      break;
    }
  }

  await CIEnv.githubPost(`repos/aurelia/aurelia/issues/${CIEnv.CIRCLE_PULL_REQUEST.split('/').pop()}/comments`, {
    body: `JS Framework Benchmark: ${url}`
  });
}

try {
  main();
} catch (e) {}
