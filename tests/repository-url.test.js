import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicGitHubRepositoryUrl } from '../src/services/github-repository-url.service.js';

test('repository URL parser normalizes the supported public GitHub URL forms', () => {
  for (const url of [
    'https://github.com/owner/repository',
    'https://github.com/owner/repository/',
    'https://github.com/owner/repository.git'
  ]) {
    assert.deepEqual(parsePublicGitHubRepositoryUrl(url), {
      owner: 'owner', repository: 'repository', canonicalUrl: 'https://github.com/owner/repository'
    });
  }
});

test('repository URL parser rejects unsafe, ambiguous, and non-repository URLs', () => {
  const invalidUrls = [
    'http://github.com/owner/repository',
    'https://notgithub.com/owner/repository',
    'https://www.github.com/owner/repository',
    'https://github.com.evil.example/owner/repository',
    'https://github.com:8443/owner/repository',
    'https://user:password@github.com/owner/repository',
    'https://github.com/owner',
    'https://github.com/owner/repository/issues/1',
    'https://github.com/owner/repository/pulls',
    'https://github.com/owner/repository?tab=readme',
    'https://github.com/owner/repository#readme',
    'https://github.com//repository',
    'https://github.com/owner/.',
    'https://github.com/owner/%72epository',
    ' https://github.com/owner/repository',
    'https://github.com/owner/repo/extra.git'
  ];
  for (const url of invalidUrls) {
    assert.throws(() => parsePublicGitHubRepositoryUrl(url), { code: 'INVALID_REPOSITORY_URL' }, url);
  }
  assert.throws(() => parsePublicGitHubRepositoryUrl(null), { code: 'INVALID_REPOSITORY_URL' });
});
