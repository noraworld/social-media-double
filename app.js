'use strict';

import crypto from 'crypto';
import * as Misskey from 'misskey-js';
import { Octokit } from '@octokit/rest';

const cache = new Map();
const spiltCommentsCheckAttemptsMaximum = process.env.DRY_RUN === 'true' ? 1 : 5;

async function run() {
  let comments = null;
  let attempt = 0;

  while (true) {
    comments = await getComments();
    if (comments.length === 0) break;
    await post(comments);

    attempt++;
    if (process.env.DRY_RUN === 'true') {
      console.info('The action is supposed to be performed until all the comments are transferred, but it is done only once because dry run is enabled.');
      process.exit(0);
    }
    else if (attempt >= spiltCommentsCheckAttemptsMaximum) {
      console.error(`The action was run ${attempt} times, but the comments still exist.`);
      process.exit(1);
    }
  }
}

async function getComments() {
  const api = setupAPI();
  let comments = [];
  let page = 1;
  const perPage = 100;
  let response = null;

  do {
    response = await api.octokit.issues.listComments({
      owner: api.owner,
      repo: api.repo,
      issue_number: process.env.ISSUE_NUMBER,
      page,
      per_page: perPage,
    });

    comments = comments.concat(response.data);
    page++;
  } while (response.data.length === perPage);

  return comments;
}

async function post(comments) {
  let content, options, files, fileIDs;

  for (let comment of comments) {
    try {
      [ content, options ] = setOptions(comment.body);
      [ content, files ] = await extractAttachedFiles(content);
      fileIDs = await uploadFiles(files);

      await createNote(content, fileIDs, options);
      await deleteComment(comment.id);
    }
    catch (error) {
      console.error('An error occurred while creating a post or delete a comment!');
      console.error(error);
      process.exit(1);
    }
  }
}

async function createNote(contentBody, fileIDs, options) {
  const defaultParams = { text: contentBody };
  if (fileIDs.length) defaultParams.fileIds = fileIDs; // MEMO: { fileIds: [] } or { fileIds: null } is not acceptable
  const params = { ...defaultParams, ...options };

  if (process.env.DRY_RUN === 'true') {
    console.info(`The comment "${contentBody.split(/[\r\n|\r|\n]/)[0]}" is supposed to be posted, but not done because dry run is enabled.`);
    console.info('params: ', params);
    return true;
  }

  const note = await setupAPI().misskey.request('notes/create', params);

  return note;
}

// INFO: it may upload the same files when the comment is different, even if the caches are found
async function uploadFiles(files) {
  if (!files.length) return files;
  const fileIDs = [];

  for (let file of files) {
    if (process.env.DRY_RUN === 'true') {
      console.info(`The file <Buffer ${file.length} bytes> is supposed to be uploaded, but not done because dry run is enabled.`);
      fileIDs.push(Math.random().toString(32).substring(2));
      continue;
    }

    // misskey-js doesn't work properly
    // https://github.com/noraworld/to-do/issues/1437
    const response = await callAPIbyFetch('drive/files/create', file);
    fileIDs.push(response.id);
  }

  return fileIDs;
}

async function deleteComment(commentID) {
  const api = setupAPI();

  if (process.env.DRY_RUN === 'true') {
    console.info(`The comment "${commentID}" is supposed to be deleted, but not done because dry run is enabled.\n`);
    return true;
  }

  await setupAPI().octokit.issues.deleteComment({
    owner: api.owner,
    repo: api.repo,
    comment_id: commentID,
  });
}

async function callAPIbyFetch(endpoint, file) {
  const form = new FormData();
  form.append('i', process.env.MISSKEY_API_TOKEN);
  form.append('file', new Blob([file.buffer]), file.name);

  const response = await fetch(
    `https://${process.env.MISSKEY_SERVER}/api/${endpoint}`,
    {
      method: 'POST',
      body: form,
    }
  );

  return await response.json();
}

function setupAPI() {
  const octokit = process.env.PERSONAL_ACCESS_TOKEN ?
                  new Octokit({ auth: process.env[process.env.PERSONAL_ACCESS_TOKEN] }) :
                  new Octokit({ auth: process.env.GITHUB_TOKEN });
  const repository = process.env.GITHUB_REPOSITORY;
  const [ owner, repo ] = repository.split('/');

  const misskey = new Misskey.api.APIClient({
    origin: `https://${process.env.MISSKEY_SERVER}`,
    credential: process.env.MISSKEY_API_TOKEN,
  });

  return {
    octokit: octokit,
    owner: owner,
    repo: repo,
    misskey: misskey,
  };
}

function setOptions(commentBody) {
  const regex = new RegExp(/^<!--\s*(\{.+?\})\s*-->/s);
  const match = commentBody.trim().match(regex);
  const options = match ? JSON.parse(match[1]) : {};

  return [
    commentBody.replace(regex, '').trim(),
    options,
  ];
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
// https://chatgpt.com/share/67dc00c4-4b0c-8004-9e30-4cd77023249a
// https://chatgpt.com/share/67fa6146-f6c4-8004-9c22-3891c4884d85
// https://www.bugbugnow.net/2020/02/Escape-characters-used-in-regular-expressions.html
async function extractAttachedFiles(commentBody) {
  // a simple way to detect links like ![foo](https://example.com) and ignore `![foo](https://example.com)` at the same time
  // but not perfect because it doesn't ignore the case like `hello ![foo](https://example.com) world`
  const regex = /(?<!`)(?:!\[.*?\]\((https?:\/\/[^\s)]+)\)|<img.*?src="(https?:\/\/[^\s"]+)"(?!.*exclude).*>)(?!`)/g;
  const files = [];

  for (const match of commentBody.matchAll(regex)) {
    const tag = match[0];
    const url = match[1] || match[2];

    // to avoid downloading the same file
    if (!cache.has(url)) {
      cache.set(url, await downloadFile(url));

      files.push({
        name: generateFileHash(url),
        buffer: cache.get(url),
      });
    }
    else if (process.env.DRY_RUN === 'true') {
      console.info(`downloading url ${url} has skipped because the cache has found.\n`);
    }

    commentBody = commentBody.replace(new RegExp(escapeRegExp(tag) + '(\\r\\n|\\r|\\n)*'), '');
  }

  const resolvedReplacements = await Promise.all(
    [...cache.entries()].map(async ([url, promise]) => [url, await promise])
  );

  for (const [url, newUrl] of resolvedReplacements) {
    cache.set(url, newUrl);
  }

  return [
    commentBody,
    files,
  ];
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
async function downloadFile(url) {
  let headers = null;
  const token = process.env.PERSONAL_ACCESS_TOKEN ?
                process.env[process.env.PERSONAL_ACCESS_TOKEN] :
                process.env.GITHUB_TOKEN;

  // to avoid exposing the GitHub token to somewhere else
  if (url.startsWith('https://github.com')) {
    headers = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Node.js',
    };
  }
  else {
    headers = {
      'User-Agent': 'Node.js',
    };
  }

  if (process.env.DRY_RUN === 'true') console.info(`downloading file ${url}`);
  const response = await fetch(url, { headers: headers });
  if (!response.ok) throw new Error(`Failed to fetch attached file ${url}: ${response.statusText}`);
  if (process.env.DRY_RUN === 'true') console.info(`file ${url} downloaded`);
  if (process.env.DRY_RUN === 'true') console.info(`creating buffer from ${url}`);
  const buffer = await response.arrayBuffer();
  if (process.env.DRY_RUN === 'true') console.info(`buffer from ${url} created\n`);

  return buffer;
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
function generateFileHash(url) {
  return crypto.createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 32);
}

function escapeRegExp(string) {
  return string.replace(/([\x00-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F])/g, '\\$&');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
